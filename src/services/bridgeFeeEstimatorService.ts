/**
 * Bridge Cross-Chain Message Relayer Fee Estimator – Issue #1306
 *
 * Estimates the relayer execution fee a cross-chain bridge must reserve to
 * cover the target network's gas cost of executing a message payload:
 *
 *   F_relayer = Gas_target × P_gas × (1 + margin)
 *
 * Gas prices are fetched from the target network RPC and kept in a small
 * in-memory cache that is refreshed in the background. The estimation path
 * itself never performs network I/O, so it stays well under the 15 ms service
 * level objective even when the upstream RPC is slow.
 */

import { ethers } from "ethers";
import { logger } from "../utils/logger";

export type BridgeChainType = "EVM" | "Solana";
export type GasPriceUnit = "wei" | "microLamports";
export type GasPriceSource = "rpc" | "fallback";

export interface BridgeFeeNetwork {
  /** Stable lowercase lookup key, e.g. "ethereum". */
  key: string;
  /** EVM chain id or network identifier (e.g. "1", "137", "solana"). */
  chainId: string;
  chainName: string;
  chainType: BridgeChainType;
  rpcUrl: string;
  nativeCurrency: string;
  /** Gas price used when the RPC is unreachable. */
  fallbackGasPrice: bigint;
  gasPriceUnit: GasPriceUnit;
  /** Decimals used to render the native fee amount. */
  feeDecimals: number;
  /** Additional gas consumed per payload byte. */
  gasPerByte: number;
  /** Fixed gas overhead of a relayer execution. */
  baseGasUnits: number;
}

export interface BridgeFeeEstimateInput {
  /** Network key, chain id, or chain name (case-insensitive). */
  targetNetwork: string;
  /** Explicit execution gas/compute units. Takes precedence over payloadBytes. */
  gasUnits?: number;
  /** Serialized payload size; converted to gas units using gasPerByte. */
  payloadBytes?: number;
  /** Safety margin as a fraction, e.g. 0.1 = 10%. */
  margin?: number;
}

export interface BridgeFeeEstimate {
  targetNetwork: string;
  network: string;
  chainId: string;
  chainType: BridgeChainType;
  gasUnits: string;
  gasPrice: string;
  gasPriceUnit: GasPriceUnit;
  margin: number;
  baseFee: string;
  relayerFee: string;
  relayerFeeFormatted: string;
  nativeCurrency: string;
  gasPriceSource: GasPriceSource;
  gasPriceFetchedAt: string;
  cacheHit: boolean;
  stale: boolean;
  latencyMs: number;
}

interface GasPriceSnapshot {
  gasPrice: bigint;
  source: GasPriceSource;
  fetchedAt: number;
}

export interface BridgeFeeEstimatorOptions {
  networks?: BridgeFeeNetwork[];
  cacheTtlMs?: number;
  refreshIntervalMs?: number;
  rpcTimeoutMs?: number;
  providerFactory?: (rpcUrl: string) => ethers.JsonRpcProvider;
  fetchImpl?: typeof fetch;
}

export class BridgeFeeEstimatorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeFeeEstimatorError";
  }
}

const DEFAULT_MARGIN = 0.1;
const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_REFRESH_INTERVAL_MS = 10_000;
const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const MIN_SOLANA_PRIORITY_FEE_MICROLAMPORTS = 1_000n;

interface NetworkBlueprint {
  key: string;
  chainId: string;
  chainName: string;
  chainType: BridgeChainType;
  defaultRpcUrl: string;
  nativeCurrency: string;
  fallbackGasPrice: bigint;
  gasPriceUnit: GasPriceUnit;
  feeDecimals: number;
  gasPerByte: number;
  baseGasUnits: number;
}

const NETWORK_BLUEPRINTS: readonly NetworkBlueprint[] = [
  {
    key: "ethereum",
    chainId: "1",
    chainName: "Ethereum",
    chainType: "EVM",
    defaultRpcUrl: "https://eth.llamarpc.com",
    nativeCurrency: "ETH",
    fallbackGasPrice: 20_000_000_000n,
    gasPriceUnit: "wei",
    feeDecimals: 18,
    gasPerByte: 16,
    baseGasUnits: 21_000,
  },
  {
    key: "polygon",
    chainId: "137",
    chainName: "Polygon",
    chainType: "EVM",
    defaultRpcUrl: "https://polygon.llamarpc.com",
    nativeCurrency: "POL",
    fallbackGasPrice: 30_000_000_000n,
    gasPriceUnit: "wei",
    feeDecimals: 18,
    gasPerByte: 16,
    baseGasUnits: 21_000,
  },
  {
    key: "bsc",
    chainId: "56",
    chainName: "BNB Smart Chain",
    chainType: "EVM",
    defaultRpcUrl: "https://bsc-dataseed.binance.org",
    nativeCurrency: "BNB",
    fallbackGasPrice: 3_000_000_000n,
    gasPriceUnit: "wei",
    feeDecimals: 18,
    gasPerByte: 16,
    baseGasUnits: 21_000,
  },
  {
    key: "arbitrum",
    chainId: "42161",
    chainName: "Arbitrum One",
    chainType: "EVM",
    defaultRpcUrl: "https://arb1.arbitrum.io/rpc",
    nativeCurrency: "ETH",
    fallbackGasPrice: 100_000_000n,
    gasPriceUnit: "wei",
    feeDecimals: 18,
    gasPerByte: 16,
    baseGasUnits: 21_000,
  },
  {
    key: "optimism",
    chainId: "10",
    chainName: "Optimism",
    chainType: "EVM",
    defaultRpcUrl: "https://mainnet.optimism.io",
    nativeCurrency: "ETH",
    fallbackGasPrice: 50_000_000n,
    gasPriceUnit: "wei",
    feeDecimals: 18,
    gasPerByte: 16,
    baseGasUnits: 21_000,
  },
  {
    key: "base",
    chainId: "8453",
    chainName: "Base",
    chainType: "EVM",
    defaultRpcUrl: "https://mainnet.base.org",
    nativeCurrency: "ETH",
    fallbackGasPrice: 50_000_000n,
    gasPriceUnit: "wei",
    feeDecimals: 18,
    gasPerByte: 16,
    baseGasUnits: 21_000,
  },
  {
    key: "solana",
    chainId: "solana",
    chainName: "Solana",
    chainType: "Solana",
    defaultRpcUrl: "https://api.mainnet-beta.solana.com",
    nativeCurrency: "SOL",
    fallbackGasPrice: MIN_SOLANA_PRIORITY_FEE_MICROLAMPORTS,
    gasPriceUnit: "microLamports",
    // 1 SOL = 1e15 microLamports (1e9 lamports × 1e6 microLamports).
    feeDecimals: 15,
    gasPerByte: 1,
    baseGasUnits: 5_000,
  },
];

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function rpcUrlFor(blueprint: NetworkBlueprint): string {
  const envKey = `BRIDGE_${blueprint.key.toUpperCase()}_RPC_URL`;
  const override = process.env[envKey]?.trim();
  return override && override.length > 0 ? override : blueprint.defaultRpcUrl;
}

export function buildDefaultNetworks(): BridgeFeeNetwork[] {
  return NETWORK_BLUEPRINTS.map((blueprint) => ({
    key: blueprint.key,
    chainId: blueprint.chainId,
    chainName: blueprint.chainName,
    chainType: blueprint.chainType,
    rpcUrl: rpcUrlFor(blueprint),
    nativeCurrency: blueprint.nativeCurrency,
    fallbackGasPrice: blueprint.fallbackGasPrice,
    gasPriceUnit: blueprint.gasPriceUnit,
    feeDecimals: blueprint.feeDecimals,
    gasPerByte: blueprint.gasPerByte,
    baseGasUnits: blueprint.baseGasUnits,
  }));
}

/** Renders a BigInt with the supplied decimals without losing precision. */
export function formatUnitsBigInt(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const whole = magnitude / divisor;
  const fraction = magnitude % divisor;
  const sign = negative ? "-" : "";
  if (fraction === 0n) return `${sign}${whole}`;
  const fractionStr = fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${sign}${whole}.${fractionStr}`;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class BridgeFeeEstimatorService {
  private readonly networks: BridgeFeeNetwork[];
  private readonly lookup = new Map<string, BridgeFeeNetwork>();
  private readonly cache = new Map<string, GasPriceSnapshot>();
  private readonly cacheTtlMs: number;
  private readonly refreshIntervalMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly providerFactory: (rpcUrl: string) => ethers.JsonRpcProvider;
  private readonly fetchImpl: typeof fetch;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;

  constructor(options: BridgeFeeEstimatorOptions = {}) {
    this.networks = options.networks ?? buildDefaultNetworks();
    this.cacheTtlMs =
      options.cacheTtlMs ??
      envNumber("BRIDGE_FEE_GAS_CACHE_TTL_MS", DEFAULT_CACHE_TTL_MS);
    this.refreshIntervalMs =
      options.refreshIntervalMs ??
      envNumber("BRIDGE_FEE_REFRESH_INTERVAL_MS", DEFAULT_REFRESH_INTERVAL_MS);
    this.rpcTimeoutMs =
      options.rpcTimeoutMs ??
      envNumber("BRIDGE_FEE_RPC_TIMEOUT_MS", DEFAULT_RPC_TIMEOUT_MS);
    this.providerFactory =
      options.providerFactory ??
      ((rpcUrl: string) => new ethers.JsonRpcProvider(rpcUrl));
    this.fetchImpl = options.fetchImpl ?? fetch;

    for (const network of this.networks) {
      for (const alias of [network.key, network.chainId, network.chainName]) {
        this.lookup.set(alias.toLowerCase(), network);
      }
    }
  }

  /** Lists the target networks this estimator can price. */
  getNetworks(): BridgeFeeNetwork[] {
    return [...this.networks];
  }

  /** Resolves a network by key, chain id, or name. */
  resolveNetwork(target: string): BridgeFeeNetwork {
    const network = this.lookup.get(target.trim().toLowerCase());
    if (!network) {
      throw new BridgeFeeEstimatorError(
        "UNKNOWN_NETWORK",
        `Unsupported target network: ${target}`,
      );
    }
    return network;
  }

  /**
   * Injects a gas price into the cache. Primarily used by warmers and tests.
   */
  setGasPrice(
    target: string,
    gasPrice: bigint | number | string,
    source: GasPriceSource = "rpc",
  ): void {
    const network = this.resolveNetwork(target);
    this.cache.set(network.key, {
      gasPrice: BigInt(gasPrice),
      source,
      fetchedAt: Date.now(),
    });
  }

  /**
   * Computes F_relayer from the cached gas price. This method is synchronous by
   * design so the HTTP handler never waits on an RPC round-trip.
   */
  estimateFee(input: BridgeFeeEstimateInput): BridgeFeeEstimate {
    const started = Date.now();
    const network = this.resolveNetwork(input.targetNetwork);

    const gasUnits = this.resolveGasUnits(network, input);
    const margin = this.resolveMargin(input.margin);
    const snapshot = this.cache.get(network.key);
    const now = Date.now();
    const gasPrice = snapshot?.gasPrice ?? network.fallbackGasPrice;

    const baseFee = gasPrice * BigInt(gasUnits);
    const marginBps = BigInt(Math.round((1 + margin) * 10_000));
    const relayerFee = (baseFee * marginBps) / 10_000n;

    const fetchedAt = snapshot?.fetchedAt ?? now;
    const stale = snapshot === undefined || now - fetchedAt > this.cacheTtlMs;

    return {
      targetNetwork: input.targetNetwork,
      network: network.key,
      chainId: network.chainId,
      chainType: network.chainType,
      gasUnits: gasUnits.toString(),
      gasPrice: gasPrice.toString(),
      gasPriceUnit: network.gasPriceUnit,
      margin,
      baseFee: baseFee.toString(),
      relayerFee: relayerFee.toString(),
      relayerFeeFormatted: formatUnitsBigInt(relayerFee, network.feeDecimals),
      nativeCurrency: network.nativeCurrency,
      gasPriceSource: snapshot?.source ?? "fallback",
      gasPriceFetchedAt: new Date(fetchedAt).toISOString(),
      cacheHit: snapshot !== undefined,
      stale,
      latencyMs: Date.now() - started,
    };
  }

  private resolveGasUnits(
    network: BridgeFeeNetwork,
    input: BridgeFeeEstimateInput,
  ): number {
    if (input.gasUnits !== undefined) {
      return Math.trunc(input.gasUnits);
    }
    const payloadBytes = input.payloadBytes ?? 0;
    return Math.round(network.baseGasUnits + payloadBytes * network.gasPerByte);
  }

  private resolveMargin(override?: number): number {
    if (override !== undefined) return override;
    return envNumber("BRIDGE_RELAYER_FEE_MARGIN", DEFAULT_MARGIN);
  }

  /**
   * Refreshes gas prices for the configured networks. Failures fall back to a
   * previously cached value, or the network's static fallback price.
   */
  async refreshGasPrices(networkKeys?: string[]): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const targets = networkKeys
        ? networkKeys.map((target) => this.resolveNetwork(target))
        : this.networks;

      await Promise.allSettled(
        targets.map(async (network) => {
          const gasPrice = await this.fetchGasPrice(network);
          if (gasPrice !== null) {
            this.cache.set(network.key, {
              gasPrice,
              source: "rpc",
              fetchedAt: Date.now(),
            });
          } else if (!this.cache.has(network.key)) {
            this.cache.set(network.key, {
              gasPrice: network.fallbackGasPrice,
              source: "fallback",
              fetchedAt: Date.now(),
            });
          }
        }),
      );
    } finally {
      this.refreshing = false;
    }
  }

  private async fetchGasPrice(
    network: BridgeFeeNetwork,
  ): Promise<bigint | null> {
    try {
      if (network.chainType === "Solana") {
        return await this.fetchSolanaGasPrice(network);
      }
      return await this.fetchEvmGasPrice(network);
    } catch (error) {
      logger.warn("[BridgeFeeEstimator] Gas price fetch failed", {
        network: network.key,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  private async fetchEvmGasPrice(network: BridgeFeeNetwork): Promise<bigint> {
    const provider = this.providerFactory(network.rpcUrl);
    try {
      const feeData = await withTimeout(
        provider.getFeeData(),
        this.rpcTimeoutMs,
        `${network.key} getFeeData`,
      );
      const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
      if (gasPrice === null) {
        throw new Error("RPC did not return a gas price");
      }
      return gasPrice;
    } finally {
      (provider as unknown as { destroy?: () => void }).destroy?.();
    }
  }

  private async fetchSolanaGasPrice(
    network: BridgeFeeNetwork,
  ): Promise<bigint> {
    const response = await withTimeout(
      this.fetchImpl(network.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getRecentPrioritizationFees",
          params: [[]],
        }),
      }),
      this.rpcTimeoutMs,
      `${network.key} getRecentPrioritizationFees`,
    );

    if (!response.ok) {
      throw new Error(`Solana RPC responded with status ${response.status}`);
    }

    const body = (await response.json()) as {
      result?: Array<{ prioritizationFee?: number }>;
    };
    const result = Array.isArray(body.result) ? body.result : [];
    const fees = result
      .map((entry) => Number(entry?.prioritizationFee))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((a, b) => a - b);

    if (fees.length === 0) {
      return network.fallbackGasPrice;
    }

    const median = fees[Math.floor(fees.length / 2)] ?? 0;
    const gasPrice = BigInt(Math.round(median));
    return gasPrice > 0n ? gasPrice : network.fallbackGasPrice;
  }

  /** Starts background gas price refreshes. Safe to call multiple times. */
  start(): void {
    if (this.timer) return;
    void this.refreshGasPrices();
    this.timer = setInterval(() => {
      void this.refreshGasPrices();
    }, this.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

let bridgeFeeEstimatorInstance: BridgeFeeEstimatorService | null = null;

export function getBridgeFeeEstimatorService(): BridgeFeeEstimatorService {
  if (!bridgeFeeEstimatorInstance) {
    bridgeFeeEstimatorInstance = new BridgeFeeEstimatorService();
  }
  return bridgeFeeEstimatorInstance;
}
