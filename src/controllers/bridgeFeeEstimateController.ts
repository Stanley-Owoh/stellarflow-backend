/**
 * Bridge Cross-Chain Message Relayer Fee Estimator Controller – Issue #1306
 *
 * Exposes GET/POST /api/v1/bridge/estimate-fee. The handler is intentionally
 * thin: it validates input and delegates to the cached estimator service so the
 * response stays within the 15 ms service level objective.
 */

import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError";
import {
  BridgeFeeEstimatorError,
  getBridgeFeeEstimatorService,
  type BridgeFeeEstimateInput,
} from "../services/bridgeFeeEstimatorService";

const MAX_MARGIN = 10;

function parseOptionalNumber(
  value: unknown,
): { ok: true; value?: number } | { ok: false; message: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true };
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, message: "must be a non-negative number" };
  }
  return { ok: true, value: parsed };
}

/**
 * GET/POST /api/v1/bridge/estimate-fee
 *
 * Query/body parameters:
 *   targetNetwork  {string}  Required. Network key, chain id, or chain name.
 *   gasUnits       {number}  Optional. Explicit execution gas/compute units.
 *   payloadBytes   {number}  Optional. Serialized bridge payload size.
 *   margin         {number}  Optional. Safety margin fraction (default 0.1).
 */
export async function estimateBridgeFee(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const source =
      req.method === "GET"
        ? req.query
        : ((req.body ?? {}) as Record<string, unknown>);

    const targetNetwork = source["targetNetwork"];
    if (typeof targetNetwork !== "string" || targetNetwork.trim() === "") {
      sendApiError(res, 400, "VALIDATION_ERROR", "targetNetwork is required");
      return;
    }

    const gasUnits = parseOptionalNumber(source["gasUnits"]);
    if (!gasUnits.ok) {
      sendApiError(
        res,
        400,
        "VALIDATION_ERROR",
        `gasUnits ${gasUnits.message}`,
      );
      return;
    }

    const payloadBytes = parseOptionalNumber(source["payloadBytes"]);
    if (!payloadBytes.ok) {
      sendApiError(
        res,
        400,
        "VALIDATION_ERROR",
        `payloadBytes ${payloadBytes.message}`,
      );
      return;
    }

    const margin = parseOptionalNumber(source["margin"]);
    if (!margin.ok) {
      sendApiError(res, 400, "VALIDATION_ERROR", `margin ${margin.message}`);
      return;
    }
    if (margin.value !== undefined && margin.value > MAX_MARGIN) {
      sendApiError(
        res,
        400,
        "VALIDATION_ERROR",
        `margin must not exceed ${MAX_MARGIN}`,
      );
      return;
    }

    const input: BridgeFeeEstimateInput = {
      targetNetwork: targetNetwork.trim(),
    };
    if (gasUnits.value !== undefined) input.gasUnits = gasUnits.value;
    if (payloadBytes.value !== undefined)
      input.payloadBytes = payloadBytes.value;
    if (margin.value !== undefined) input.margin = margin.value;

    const estimate = getBridgeFeeEstimatorService().estimateFee(input);

    res.json({
      success: true,
      data: estimate,
    });
  } catch (error) {
    if (error instanceof BridgeFeeEstimatorError) {
      sendApiError(res, 400, error.code, error.message);
      return;
    }
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : undefined,
    );
  }
}
