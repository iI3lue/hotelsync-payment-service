import express from "express";
import request from "supertest";
import { httpMetrics, metricsHandler } from "../../src/lib/metrics";

jest.mock("../../src/lib/prisma", () => ({
  prisma: { eventOutbox: { count: jest.fn().mockResolvedValue(0) } },
}));

jest.mock("../../src/lib/broker", () => ({
  isConnected: () => false,
}));

function createApp() {
  const app = express();
  app.use(httpMetrics);
  app.get("/metrics", metricsHandler);
  app.get("/ping", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("metrics endpoint", () => {
  it("exposes prom-client metrics with the HTTP counter", async () => {
    const app = createApp();

    await request(app).get("/ping");
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("hotelsync_http_requests_total");
  });
});