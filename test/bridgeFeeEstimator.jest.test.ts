/**
 * Issue #1306 – cross-chain bridge relayer fee estimator.
 * Verifies the fee formula, payload-to-gas conversion, margin handling and
 * fallback behaviour without hitting a live RPC.
 */
import { describe, it, expect, jest } from "@jest/globals";
import {
  BridgeFeeEstimatorError,
  BridgeFeeEstimatorService,
  formatUnitsBigInt,
  type BridgeFeeNetwork,
} from "../src/services/bridgeFeeEstimatorService";

const TEST_NETWORK: BridgeFeeNetwork = {
  key: "ethereum",
  chainId: "1",
  chainName: "Ethereum",
  chainType: "EVM",
  rpcUrl: "http://localhost:0",
  nativeCurrency: "ETH",
  fallbackGasPrice: 20_000_000_000n,
  gasPriceUnit: "wei",
  feeDecimals: 18,
  gasPerByte: 16,
  baseGasUnits: 21_000,
};

function buildService(): BridgeFeeEstimatorService {
  return new BridgeFeeEstimatorService({
    networks: [TEST_NETWORK],
    cacheTtlMs: 60_000,
    refreshIntervalMs: 60_000,
  });
}

describe("BridgeFeeEstimatorService", () => {
  it("computes F_relayer = Gas x P_gas x (1 + margin)", () => {
    const service = buildService();
    service.setGasPrice("ethereum", 20_000_000_000n);

    const estimate = service.estimateFee({
      targetNetwork: "1",
      gasUnits: 21_000,
      margin: 0.1,
    });

    // 21000 * 20 gwei = 420000 gwei = 4.2e14 wei; +10% = 4.62e14 wei
    expect(estimate.baseFee).toBe("420000000000000");
    expect(estimate.relayerFee).toBe("462000000000000");
    expect(estimate.relayerFeeFormatted).toBe("0.000462");
    expect(estimate.margin).toBe(0.1);
    expect(estimate.gasPriceSource).toBe("rpc");
    expect(estimate.cacheHit).toBe(true);
  });

  it("derives gas units from payload execution size", () => {
    const service = buildService();
    service.setGasPrice("ethereum", 1_000_000_000n);

    const estimate = service.estimateFee({
      targetNetwork: "ethereum",
      payloadBytes: 100,
      margin: 0,
    });

    // 21000 base + 100 * 16 = 22600 gas units
    expect(estimate.gasUnits).toBe("22600");
    expect(estimate.relayerFee).toBe((22_600n * 1_000_000_000n).toString());
  });

  it("uses the network fallback price when the cache is cold", () => {
    const service = buildService();

    const estimate = service.estimateFee({
      targetNetwork: "Ethereum",
      gasUnits: 21_000,
      margin: 0.1,
    });

    expect(estimate.cacheHit).toBe(false);
    expect(estimate.stale).toBe(true);
    expect(estimate.gasPriceSource).toBe("fallback");
    expect(estimate.gasPrice).toBe("20000000000");
  });

  it("rejects unsupported target networks", () => {
    const service = buildService();

    expect(() =>
      service.estimateFee({ targetNetwork: "dogecoin", gasUnits: 21_000 }),
    ).toThrow(BridgeFeeEstimatorError);

    try {
      service.estimateFee({ targetNetwork: "dogecoin", gasUnits: 21_000 });
    } catch (error) {
      expect((error as BridgeFeeEstimatorError).code).toBe("UNKNOWN_NETWORK");
    }
  });

  it("refreshes gas prices from the RPC and caches them", async () => {
    const getFeeData = jest.fn(async () => ({
      gasPrice: 42_000_000_000n,
      maxFeePerGas: null,
    }));
    const destroy = jest.fn();
    const service = new BridgeFeeEstimatorService({
      networks: [TEST_NETWORK],
      providerFactory: (() => ({ getFeeData, destroy })) as never,
    });

    await service.refreshGasPrices(["ethereum"]);

    const estimate = service.estimateFee({
      targetNetwork: "ethereum",
      gasUnits: 21_000,
      margin: 0,
    });
    expect(getFeeData).toHaveBeenCalledTimes(1);
    expect(estimate.gasPrice).toBe("42000000000");
    expect(estimate.gasPriceSource).toBe("rpc");
    expect(estimate.cacheHit).toBe(true);
    expect(estimate.stale).toBe(false);
  });

  it("falls back gracefully when the RPC fetch fails", async () => {
    const service = new BridgeFeeEstimatorService({
      networks: [TEST_NETWORK],
      providerFactory: (() => ({
        getFeeData: jest.fn(async () => {
          throw new Error("rpc down");
        }),
        destroy: jest.fn(),
      })) as never,
    });

    await service.refreshGasPrices(["ethereum"]);

    const estimate = service.estimateFee({
      targetNetwork: "ethereum",
      gasUnits: 21_000,
      margin: 0,
    });
    expect(estimate.gasPriceSource).toBe("fallback");
    expect(estimate.gasPrice).toBe("20000000000");
  });
});

describe("formatUnitsBigInt", () => {
  it("renders whole and fractional values", () => {
    expect(formatUnitsBigInt(1_000_000_000_000_000_000n, 18)).toBe("1");
    expect(formatUnitsBigInt(462_000_000_000_000n, 18)).toBe("0.000462");
    expect(formatUnitsBigInt(0n, 18)).toBe("0");
  });
});
