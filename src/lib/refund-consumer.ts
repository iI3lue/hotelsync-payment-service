import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { connect } from "./broker";
import { refundBooking } from "../services/payment.service";
import { BookingCancelledEventSchema } from "../validators/payment";

const EXCHANGE = "hotelsync.events";
const QUEUE = "payment.booking-cancellations";
const ROUTING_KEY = "booking.cancelled";
const RETRY_DELAY_MS = 5_000;
const RESUBSCRIBE_DELAY_MS = 2_000;

/**
 * Consumidor de `booking.cancelled` (booking-service -> payment-service).
 * Reembolsa el cobro si estaba COMPLETED; si sigue PROCESSING, deja la
 * reversión agendada para cuando termine la autorización.
 */
export async function handleBookingCancelledMessage(
  channel: Pick<ConfirmChannel, "ack" | "nack">,
  msg: ConsumeMessage,
  delayMs = RETRY_DELAY_MS
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(msg.content.toString("utf8"));
  } catch {
    console.error("[refunds-consumer] mensaje no es JSON, se descarta");
    channel.ack(msg);
    return;
  }

  const parsed = BookingCancelledEventSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("[refunds-consumer] payload inválido, se descarta", parsed.error.issues);
    channel.ack(msg);
    return;
  }

  try {
    const outcome = await refundBooking(parsed.data.booking_id);
    if (outcome !== "ignored") {
      console.log(`[refunds-consumer] booking=${parsed.data.booking_id} ${outcome}`);
    }
    channel.ack(msg);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `[refunds-consumer] error reembolsando booking=${parsed.data.booking_id}: ${reason}; reintento en ${delayMs}ms`
    );
    setTimeout(() => channel.nack(msg, false, true), delayMs).unref?.();
  }
}

export async function startRefundConsumer(): Promise<void> {
  const channel = await connect();
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);
  await channel.prefetch(1);
  await channel.consume(
    QUEUE,
    (msg) => {
      if (!msg) return;
      void handleBookingCancelledMessage(channel, msg);
    },
    { noAck: false }
  );

  channel.once("close", () => {
    setTimeout(() => {
      startRefundConsumer().catch((err) =>
        console.error("[refunds-consumer] no se pudo re-suscribir", err)
      );
    }, RESUBSCRIBE_DELAY_MS).unref?.();
  });
  console.log(`[refunds-consumer] escuchando ${ROUTING_KEY} en ${QUEUE}`);
}
