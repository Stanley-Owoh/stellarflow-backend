/**
 * Issue #1306 – /api/v1/bridge/estimate-fee route contract.
 * Exercises the controller with a warm gas price cache.
 */
import { describe, it, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import { estimateBridgeFee } from "../src/controllers/bridgeFeeEstimateController";
import { getBridgeFeeEstimatorService } from "../src/services/bridgeFeeEstimatorService";

const app = express();
app.use(express.json());
app.get("/api/v1/bridge/estimate-fee", estimateBridgeFee);
app.post("/api/v1/bridge/estimate-fee", estimateBridgeFee);

describe("Bridge relayer fee estimate API (Issue #1306)", () => {
  beforeEach(() => {
    getBridgeFeeEstimatorService().setGasPrice("ethereum", 20_000_000_000n);
  });

  it("POST returns the relayer fee for a target network", async () => {
    const res = await request(app)
      .post("/api/v1/bridge/estimate-fee")
      .send({ targetNetwork: "1", gasUnits: 21_000, margin: 0.1 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      network: "ethereum",
      chainType: "EVM",
      gasUnits: "21000",
      baseFee: "420000000000000",
      relayerFee: "462000000000000",
      relayerFeeFormatted: "0.000462",
      nativeCurrency: "ETH",
    });
  });

  it("GET accepts query parameters", async () => {
    const res = await request(app)
      .get("/api/v1/bridge/estimate-fee")
      .query({ targetNetwork: "ethereum", payloadBytes: 100, margin: 0 });

    expect(res.status).toBe(200);
    expect(res.body.data.gasUnits).toBe("22600");
  });

  it("rejects a request without targetNetwork", async () => {
    const res = await request(app)
      .post("/api/v1/bridge/estimate-fee")
      .send({ gasUnits: 21_000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an unsupported target network", async () => {
    const res = await request(app)
      .post("/api/v1/bridge/estimate-fee")
      .send({ targetNetwork: "dogecoin", gasUnits: 21_000 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNKNOWN_NETWORK");
  });

  it("rejects a negative gasUnits value", async () => {
    const res = await request(app)
      .post("/api/v1/bridge/estimate-fee")
      .send({ targetNetwork: "1", gasUnits: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("responds within the 15 ms estimation budget", async () => {
    for (let i = 0; i < 20; i += 1) {
      const res = await request(app)
        .get("/api/v1/bridge/estimate-fee")
        .query({ targetNetwork: "1", gasUnits: 21_000 });
      expect(res.status).toBe(200);
      expect(res.body.data.latencyMs).toBeLessThan(15);
    }
  });
});
