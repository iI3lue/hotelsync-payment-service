import { createApp } from "./app";
import { getJwtSecret } from "./lib/tokens";
import { startOutboxDispatcher } from "./lib/outbox";

// Falla al arrancar (no en la primera request) si el secreto no está:
// un AUTH_JWT_SECRET distinto al de user-service da 401 en todo.
getJwtSecret();
if (!process.env.BOOKING_SERVICE_KEY) {
  console.warn("[payment-service] BOOKING_SERVICE_KEY vacío: no se podrán verificar reservas");
}

const app = createApp();
const PORT = Number(process.env.PORT) || 3010;

app.listen(PORT, () => {
  console.log(`[payment-service] Servidor corriendo en puerto ${PORT}`);
});

// Sin RABBITMQ_URL los eventos quedan `pending` y el cobro sigue funcionando.
if (process.env.RABBITMQ_URL) {
  startOutboxDispatcher();
  console.log("[payment-service] Outbox dispatcher iniciado (hotelsync.events)");
}
