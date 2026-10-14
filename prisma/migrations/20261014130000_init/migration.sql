-- payment-service: esquema inicial (PRD payment-service §5).
CREATE TABLE "payment_transactions" (
    "transaction_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "user_id" UUID,
    "hotel_id" UUID,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'COP',
    "method" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "failure_reason" VARCHAR(255),
    "auth_code" VARCHAR(40),
    "card_brand" VARCHAR(20),
    "card_last4" VARCHAR(4),
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "recorded_by" UUID,
    "received_by" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_transactions_pkey" PRIMARY KEY ("transaction_id"),
    CONSTRAINT "payment_transactions_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "payment_transactions_method_check"
        CHECK ("method" IN ('CREDIT_CARD', 'CASH', 'TRANSFER', 'TERMINAL')),
    CONSTRAINT "payment_transactions_status_check"
        CHECK ("status" IN ('PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED')),
    CONSTRAINT "payment_transactions_channel_check"
        CHECK ("channel" IN ('WEB', 'FRONT_DESK'))
);

-- Idempotencia: una reserva = un cobro.
CREATE UNIQUE INDEX "payment_transactions_booking_id_key" ON "payment_transactions"("booking_id");
CREATE INDEX "payment_transactions_hotel_id_status_idx" ON "payment_transactions"("hotel_id", "status");

CREATE TABLE "event_outbox" (
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(50) NOT NULL,
    "payload" JSON NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "event_outbox_status_created_at_idx" ON "event_outbox"("status", "created_at");
