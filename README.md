# HotelSync — Payment Service

Microservicio de pagos simulados de HotelSync: checkout del huésped, cobro manual en recepción, emisión de `payment.completed` y reembolso simulado cuando se cancela una reserva (`payment.refunded`).

- **Producción:** https://hotelsync-payment-service.onrender.com
- **Puerto local:** 3010
- **Base de datos:** `payment_db` (PostgreSQL 16)

## Responsabilidad

| Hace | No hace |
| --- | --- |
| Simular el cobro de una reserva (tarjeta, efectivo, transferencia, terminal) | Guardar tarjetas reales ni integrar una pasarela real |
| Garantizar idempotencia por reserva | Confirmar reservas (lo hace Booking al recibir el evento) |
| Registrar pagos manuales de recepción | Gestionar folios ni facturas |
| Reembolsar de forma simulada al cancelar (evento `booking.cancelled`) | Devolver dinero real ni reembolsos parciales |
| Publicar `payment.completed` y `payment.refunded` vía outbox | Ser dueño de la reserva |

## Tecnologías

Node.js ≥20 · TypeScript · Express · Prisma · PostgreSQL 16 · Zod · RabbitMQ (outbox).

## Arquitectura interna

`Route → Controller → Service → Prisma`, con Zod y `AppError`. El checkout exige al pagador (JWT del huésped o `x-manage-token` de una reserva anónima) y es idempotente: reintentar el `POST` no duplica el cobro. El evento `payment.completed` se escribe en `EventOutbox` dentro de la transacción y se publica de forma asíncrona.

El reembolso es **event-driven**: un consumidor escucha `booking.cancelled`. Si el cobro está `COMPLETED` lo pasa a `REFUNDED` y encola `payment.refunded`; si sigue `PROCESSING` marca `refund_requested` para que el checkout en curso termine como reembolsado. No hay endpoint de reembolso manual.

## Endpoints

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| GET | `/health` | — | Estado del servicio |
| POST | `/v1/checkout` | JWT del huésped o `x-manage-token` | Cobra la reserva (idempotente) |
| GET | `/v1/checkout/:bookingId` | JWT del huésped o `x-manage-token` | Estado del pago |
| POST | `/v1/admin/payments` | JWT + staff | Registra pago manual en recepción |
| GET | `/v1/admin/payments/:bookingId` | JWT + staff | Estado del pago para staff |

## Modelo de datos

Tablas: `PaymentTransaction`, `EventOutbox`. `PaymentTransaction` guarda `refund_requested` y `refunded_at` para resolver cancelaciones durante el cobro.

Migraciones en `prisma/migrations` (2). Incluye un **seed opcional** (`npm run seed`) que crea un cobro `COMPLETED` idempotente para un `booking_id` demo (override con `SEED_BOOKING_ID`, `SEED_HOTEL_ID` y `SEED_AMOUNT`); en operación las transacciones se crean por checkout o por pago manual.

## Comunicación

- **REST saliente:** Booking `GET /v1/bookings/:id` (header `x-payment-key`, que debe coincidir con `PAYMENT_SERVICE_KEY` de Booking).
- **Publica:** `payment.completed` → cola `booking.payments`; `payment.refunded` → cola `booking.refunds`.
- **Consume:** `booking.cancelled` (cola durable `payment.booking-cancellations`) → reembolso simulado.
- Sin `RABBITMQ_URL` el outbox queda `pending` y no se procesan cancelaciones.

## Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `NODE_ENV` | No | `development` / `production` |
| `PORT` | No | Puerto HTTP (default 3010) |
| `DATABASE_URL` | Sí | PostgreSQL de `payment_db` |
| `AUTH_JWT_SECRET` | Sí | HS256 compartido |
| `BOOKING_SERVICE_URL` | Sí | Base de booking-service |
| `BOOKING_SERVICE_KEY` | Sí | Debe coincidir con `PAYMENT_SERVICE_KEY` de Booking |
| `PAYMENT_CURRENCY` | No | Moneda de los cobros (default `COP`) |
| `RABBITMQ_URL` | No | Sin ella el outbox queda `pending` y no se reembolsan cancelaciones |

Copiar `.env.example` a `.env` y completar los valores.

## Ejecución local

```bash
npm install
cp .env.example .env
npx prisma migrate deploy
npm run seed                # opcional: cobro demo COMPLETED
npm run dev                 # http://localhost:3010
```

## Despliegue

Render (Oregon, free): build `npm ci && npx prisma generate && npm run build`; start `npx prisma migrate deploy && npm start`; Neon `payment_db`. El plan free duerme a los 15 minutos. El front enruta `/api/payments/*` a este servicio.

## Pruebas y verificación

```bash
npm test
npm run lint
curl https://hotelsync-payment-service.onrender.com/health
```

## Respaldo de base de datos

```bash
pg_dump "$DATABASE_URL" -Fc -f payment_db.dump
pg_restore --clean --if-exists -d "$DATABASE_URL" payment_db.dump
```

## Estructura

```
src/{routes,controllers,services,validators,middleware,lib}
prisma/{schema.prisma,migrations,seed.ts}
tests/
```
