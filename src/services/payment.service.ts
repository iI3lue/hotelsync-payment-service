import type { PaymentTransaction } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  getBookingAsService,
  getBookingWithManageToken,
  type BookingDetails,
} from "../lib/booking-client";
import { authorizeCard, cardBrand } from "../lib/mock-gateway";
import { enqueueOutboxEvent } from "../lib/outbox";
import { AppError } from "../middleware/error-handler";
import {
  STAFF_ROLES,
  type AuthUser,
  type CardInput,
  type ManualPaymentMethod,
  type Payer,
  type PaymentChannel,
  type PaymentMethod,
} from "../types";

/** Un PROCESSING más viejo que esto se considera huérfano (proceso caído). */
export const PROCESSING_STALE_MS = 2 * 60_000;
/** Tope de intentos por reserva: frena pruebas masivas de tarjetas. */
export const MAX_ATTEMPTS = 10;

export function currency(): string {
  return process.env.PAYMENT_CURRENCY || "COP";
}

/** Vista pública de una transacción: sin datos internos ni del staff. */
export function toPaymentDto(tx: PaymentTransaction) {
  return {
    transaction_id: tx.transaction_id,
    booking_id: tx.booking_id,
    amount: Number(tx.amount),
    currency: tx.currency,
    method: tx.method,
    status: tx.status,
    channel: tx.channel,
    failure_reason: tx.failure_reason,
    auth_code: tx.auth_code,
    card_brand: tx.card_brand,
    card_last4: tx.card_last4,
    attempts: tx.attempts,
    refunded_at: tx.refunded_at,
    created_at: tx.created_at,
    updated_at: tx.updated_at,
  };
}
export type PaymentDto = ReturnType<typeof toPaymentDto>;

export interface PaymentResult {
  transaction: PaymentDto;
  /** true si la reserva ya estaba cobrada y se devuelve el cobro existente. */
  replay: boolean;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

function isStaff(user?: AuthUser): boolean {
  return !!user && (STAFF_ROLES as readonly string[]).includes(user.role);
}

/** SUPER_ADMIN es global; el resto del staff solo opera su hotel. */
function assertStaffScope(user: AuthUser, booking: BookingDetails): void {
  if (user.role === "SUPER_ADMIN") return;
  if (!isStaff(user) || !user.hotelId || user.hotelId !== booking.hotel_id) {
    throw new AppError(403, "No podés operar reservas de otro hotel", "Forbidden");
  }
}

/**
 * Autorización del pagador. booking-service es la fuente de verdad:
 * - manage token: lo valida booking-service (hash + vigencia).
 * - huésped logueado: la reserva debe haberse creado con su cuenta.
 * - staff: solo su hotel (SUPER_ADMIN global).
 */
export async function resolveBookingForPayer(bookingId: string, payer: Payer): Promise<BookingDetails> {
  let booking: BookingDetails | null;
  if (payer.manageToken) {
    booking = await getBookingWithManageToken(bookingId, payer.manageToken);
  } else if (payer.user) {
    booking = await getBookingAsService(bookingId);
  } else {
    throw new AppError(401, "Iniciá sesión o usá el código de gestión de la reserva", "Unauthorized");
  }
  if (!booking) throw new AppError(404, "Reserva no encontrada", "NotFound");

  if (!payer.manageToken && payer.user) {
    if (isStaff(payer.user)) assertStaffScope(payer.user, booking);
    else if (booking.booked_by_user_id !== payer.user.userId) {
      throw new AppError(403, "Esta reserva no pertenece a tu cuenta", "Forbidden");
    }
  }
  return booking;
}

function chargeableAmount(booking: BookingDetails): number {
  const amount = Number(booking.total_amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError(422, "La reserva no tiene un total cobrable", "InvalidAmount");
  }
  return Math.round(amount * 100) / 100;
}

function assertPayable(booking: BookingDetails): void {
  if (booking.status === "cancelled") {
    throw new AppError(409, "La reserva está cancelada y no admite pagos", "Conflict");
  }
  if (booking.payment_status === "PAID") {
    // Pagada por otro medio que no pasó por este servicio (p. ej. backfill).
    throw new AppError(409, "La reserva ya figura como pagada", "Conflict");
  }
}

interface ClaimData {
  amount: number;
  method: PaymentMethod;
  channel: PaymentChannel;
  hotel_id: string;
  user_id?: string | null;
  recorded_by?: string | null;
  received_by?: string | null;
}

type Claim = { kind: "claimed"; tx: PaymentTransaction } | { kind: "completed"; tx: PaymentTransaction };

/**
 * Toma el "candado" del cobro de una reserva. La fila única por booking_id
 * pasa a PROCESSING antes de hablar con la pasarela, así dos requests
 * concurrentes nunca autorizan dos veces:
 * - sin fila: se crea PROCESSING (si otra request ganó la carrera, P2002 → se relee).
 * - COMPLETED: idempotencia, se devuelve el cobro existente.
 * - FAILED o PROCESSING huérfano: se re-toma con un update condicional.
 * - PROCESSING reciente: 409, hay otro cobro en curso.
 */
export async function claimTransaction(bookingId: string, data: ClaimData, retried = false): Promise<Claim> {
  const existing = await prisma.paymentTransaction.findUnique({ where: { booking_id: bookingId } });

  if (!existing) {
    try {
      const tx = await prisma.paymentTransaction.create({
        data: { booking_id: bookingId, status: "PROCESSING", currency: currency(), attempts: 1, ...data },
      });
      return { kind: "claimed", tx };
    } catch (error) {
      if (isUniqueViolation(error) && !retried) return claimTransaction(bookingId, data, true);
      throw error;
    }
  }

  if (existing.status === "COMPLETED") return { kind: "completed", tx: existing };
  if (existing.status === "REFUNDED") {
    throw new AppError(409, "El pago de esta reserva fue reembolsado", "Conflict");
  }

  const stale = Date.now() - existing.updated_at.getTime() > PROCESSING_STALE_MS;
  if (existing.status === "PROCESSING" && !stale) {
    throw new AppError(409, "Ya hay un pago en curso para esta reserva", "PaymentInProgress");
  }
  if (existing.attempts >= MAX_ATTEMPTS) {
    throw new AppError(429, "Se alcanzó el máximo de intentos de pago para esta reserva", "TooManyAttempts");
  }

  const taken = await prisma.paymentTransaction.updateMany({
    // `attempts` es monótono: si otra request re-tomó la fila, ya no coincide.
    where: { booking_id: bookingId, status: existing.status, attempts: existing.attempts },
    data: {
      ...data,
      status: "PROCESSING",
      failure_reason: null,
      auth_code: null,
      card_brand: null,
      card_last4: null,
      attempts: { increment: 1 },
    },
  });
  if (taken.count === 0) {
    throw new AppError(409, "Ya hay un pago en curso para esta reserva", "PaymentInProgress");
  }
  const tx = await prisma.paymentTransaction.findUniqueOrThrow({ where: { booking_id: bookingId } });
  return { kind: "claimed", tx };
}

/** COMPLETED + evento `payment.completed` en la MISMA transacción (outbox). */
async function completeTransaction(
  tx: PaymentTransaction,
  extra: { auth_code?: string | null; card_brand?: string | null; card_last4?: string | null } = {}
): Promise<PaymentTransaction> {
  return prisma.$transaction(async (db) => {
    // La reserva pudo cancelarse mientras la pasarela autorizaba: en ese caso
    // el cobro se revierte en vez de confirmarse.
    const fresh = await db.paymentTransaction.findUniqueOrThrow({
      where: { transaction_id: tx.transaction_id },
    });

    if (fresh.refund_requested) {
      const refunded = await db.paymentTransaction.update({
        where: { transaction_id: tx.transaction_id },
        data: {
          status: "REFUNDED",
          refunded_at: new Date(),
          failure_reason: "Reserva cancelada durante el cobro",
          ...extra,
        },
      });
      await enqueueOutboxEvent(db, "payment.refunded", {
        booking_id: refunded.booking_id,
        transaction_id: refunded.transaction_id,
        amount: Number(refunded.amount),
        currency: refunded.currency,
      });
      return refunded;
    }

    const done = await db.paymentTransaction.update({
      where: { transaction_id: tx.transaction_id },
      data: { status: "COMPLETED", failure_reason: null, ...extra },
    });
    await enqueueOutboxEvent(db, "payment.completed", {
      booking_id: done.booking_id,
      transaction_id: done.transaction_id,
      amount: Number(done.amount),
      currency: done.currency,
    });
    return done;
  });
}

/** Flujo A: pago web con tarjeta simulada. */
export async function processWebPayment(payer: Payer, bookingId: string, card: CardInput): Promise<PaymentResult> {
  const booking = await resolveBookingForPayer(bookingId, payer);

  // Idempotencia antes que cualquier otra regla: reintentar un cobro ya
  // hecho devuelve el mismo resultado aunque la reserva ya figure PAID.
  const prior = await prisma.paymentTransaction.findUnique({ where: { booking_id: bookingId } });
  if (prior?.status === "COMPLETED") return { transaction: toPaymentDto(prior), replay: true };

  assertPayable(booking);
  const amount = chargeableAmount(booking);
  const digits = card.number.replace(/\D/g, "");

  const claim = await claimTransaction(bookingId, {
    amount,
    method: "CREDIT_CARD",
    channel: "WEB",
    hotel_id: booking.hotel_id,
    user_id: payer.user?.userId ?? null,
  });
  if (claim.kind === "completed") return { transaction: toPaymentDto(claim.tx), replay: true };

  const auth = authorizeCard({ ...card, number: digits }, Math.round(amount * 100));
  const cardMeta = { card_brand: cardBrand(digits), card_last4: digits.slice(-4) };

  if (!auth.authorized) {
    await prisma.paymentTransaction.update({
      where: { transaction_id: claim.tx.transaction_id },
      data: { status: "FAILED", failure_reason: auth.reason ?? "Pago rechazado", ...cardMeta },
    });
    // PRD 2026-10-14: la reserva queda pending/PENDING para reintentar.
    throw new AppError(402, auth.reason ?? "Pago rechazado", "PaymentDeclined");
  }

  const done = await completeTransaction(claim.tx, { auth_code: auth.auth_code, ...cardMeta });
  return { transaction: toPaymentDto(done), replay: false };
}

/** Flujo B: pago manual en recepción (efectivo, transferencia o datáfono). */
export async function processFrontDeskPayment(
  staff: AuthUser,
  bookingId: string,
  method: ManualPaymentMethod,
  receivedBy?: string
): Promise<PaymentResult> {
  const booking = await resolveBookingForPayer(bookingId, { user: staff });
  assertStaffScope(staff, booking);

  const prior = await prisma.paymentTransaction.findUnique({ where: { booking_id: bookingId } });
  if (prior?.status === "COMPLETED") return { transaction: toPaymentDto(prior), replay: true };

  assertPayable(booking);
  const claim = await claimTransaction(bookingId, {
    amount: chargeableAmount(booking),
    method,
    channel: "FRONT_DESK",
    hotel_id: booking.hotel_id,
    recorded_by: staff.userId,
    received_by: receivedBy ?? null,
  });
  if (claim.kind === "completed") return { transaction: toPaymentDto(claim.tx), replay: true };

  const done = await completeTransaction(claim.tx);
  return { transaction: toPaymentDto(done), replay: false };
}

/** Estado de pago de una reserva, con la misma autorización que el cobro. */
export async function getPaymentStatus(payer: Payer, bookingId: string) {
  const booking = await resolveBookingForPayer(bookingId, payer);
  const tx = await prisma.paymentTransaction.findUnique({ where: { booking_id: bookingId } });
  return {
    booking_id: bookingId,
    booking_status: booking.status,
    payment_status:
      tx?.status === "COMPLETED"
        ? "PAID"
        : tx?.status === "REFUNDED"
          ? "REFUNDED"
          : booking.payment_status ?? "PENDING",
    payment_method_preference: booking.payment_method_preference ?? null,
    amount_due: Number(booking.total_amount),
    currency: currency(),
    transaction: tx ? toPaymentDto(tx) : null,
  };
}

export type RefundOutcome = "refunded" | "scheduled" | "ignored";

/**
 * Reembolso simulado al cancelarse una reserva (evento `booking.cancelled`).
 * - COMPLETED: pasa a REFUNDED y encola `payment.refunded`.
 * - PROCESSING: marca `refund_requested`; al terminar el cobro se revierte.
 * - REFUNDED/FAILED/sin transacción: no-op idempotente.
 */
export async function refundBooking(bookingId: string): Promise<RefundOutcome> {
  const existing = await prisma.paymentTransaction.findUnique({
    where: { booking_id: bookingId },
  });
  if (!existing) return "ignored";
  if (existing.status === "REFUNDED" || existing.status === "FAILED") return "ignored";

  if (existing.status === "PROCESSING") {
    await prisma.paymentTransaction.updateMany({
      where: { booking_id: bookingId, status: "PROCESSING" },
      data: { refund_requested: true },
    });
    return "scheduled";
  }

  return prisma.$transaction(async (db) => {
    // updateMany condicional: una entrega duplicada del evento no reembolsa
    // ni publica dos veces.
    const claimed = await db.paymentTransaction.updateMany({
      where: { booking_id: bookingId, status: "COMPLETED" },
      data: {
        status: "REFUNDED",
        refunded_at: new Date(),
        failure_reason: "Reserva cancelada",
      },
    });
    if (claimed.count === 0) return "ignored";

    const refunded = await db.paymentTransaction.findUniqueOrThrow({
      where: { booking_id: bookingId },
    });
    await enqueueOutboxEvent(db, "payment.refunded", {
      booking_id: refunded.booking_id,
      transaction_id: refunded.transaction_id,
      amount: Number(refunded.amount),
      currency: refunded.currency,
    });
    return "refunded";
  });
}

