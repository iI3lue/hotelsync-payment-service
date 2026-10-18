-- Reembolso simulado: la reserva cancelada revierte el cobro.
ALTER TABLE "payment_transactions" ADD COLUMN "refund_requested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "payment_transactions" ADD COLUMN "refunded_at" TIMESTAMPTZ(6);
