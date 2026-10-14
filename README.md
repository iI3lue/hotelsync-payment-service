# hotelsync-payment-service

HotelSync payment microservice (simulated gateway, checkout, webhook, front-desk manual payments). Part of the HotelSync platform - one repo per microservice.

## Endpoints

- `POST /v1/checkout` - guest checkout `{ booking_id, card }` (amount verified against booking-service; client cannot set the price)
- `GET /v1/checkout/:bookingId` - payment status for a booking
- `POST /v1/admin/payments` - front-desk manual payment `{ booking_id, method }` (CASH | TRANSFER | TERMINAL, staff only)
- `GET /v1/admin/payments/:bookingId` - payment status for staff
- `GET /health` - health check

Auth is HS256 (`AUTH_JWT_SECRET`, must be identical to user-service). Reads bookings server-to-server with `x-payment-key` (= `PAYMENT_SERVICE_KEY` of booking-service). Emits `payment.completed` via outbox + RabbitMQ; without a broker the charge still works and the outbox stays `pending`.

## Local dev

```bash
npm install
npx prisma generate
npm run dev
```

Required env (see `.env.example`): `DATABASE_URL`, `AUTH_JWT_SECRET`, `BOOKING_SERVICE_URL`, `BOOKING_SERVICE_KEY`, `PAYMENT_CURRENCY`, `RABBITMQ_URL`.
