import express from "express";
import { errorHandler } from "./middleware/error-handler";
import { checkoutRouter } from "./routes/checkout";
import { adminRouter } from "./routes/admin";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "payment-service", timestamp: new Date().toISOString() });
  });

  // Montaje bajo /v1 para que el rewrite /api/payments/:path* del front
  // resuelva 1:1 (mismo patrón que loyalty-service).
  app.use("/v1/checkout", checkoutRouter); // POST / y GET /:bookingId
  app.use("/v1/admin", adminRouter); // POST /payments y GET /payments/:bookingId

  app.use((_req, res) => {
    res.status(404).json({ error: "NotFound", message: "Ruta no encontrada", statusCode: 404 });
  });
  app.use(errorHandler);
  return app;
}
