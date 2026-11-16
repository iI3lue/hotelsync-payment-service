import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { connect } from "./broker";
import { refundBooking } from "../services/payment.service";
import { BookingCancelledEventSchema } from "../validators/payment";
import { handleDelivery } from "./consumer-delivery";

const EXCHANGE = "hotelsync.events";
const QUEUE = "payment.booking-cancellations";
const ROUTING_KEY = "booking.cancelled";
const RESUBSCRIBE_DELAY_MS = 2_000;

/**
 * Consumidor de `booking.cancelled` (booking-service -> payment-service).
 * Reembolsa el cobro si estaba COMPLETED; si sigue PROCESSING, deja la
 * reversión agendada para cuando termine la autorización. Los errores
 * transitorios se reintentan con backoff acotado y terminan en `${QUEUE}.dlq`.
 */
export async function handleBookingCancelledMessage(
  channel: Pick<ConfirmChannel, "ack" | "nack" | "sendToQueue">,
  msg: ConsumeMessage
): Promise<void> {
  await handleDelivery(
    channel,
    QUEUE,
    `${QUEUE}.dlq`,
    async (_routingKey, raw) => {
      const parsed = BookingCancelledEventSchema.safeParse(raw);
      if (!parsed.success) {
        console.error("[refunds-consumer] payload inválido, se descarta", parsed.error.issues);
        return;
      }

      const outcome = await refundBooking(parsed.data.booking_id);
      if (outcome !== "ignored") {
        console.log(`[refunds-consumer] booking=${parsed.data.booking_id} ${outcome}`);
      }
    },
    msg
  );
}

export async function startRefundConsumer(): Promise<void> {
  const channel = await connect();
  const deadLetterQueue = `${QUEUE}.dlq`;
  await channel.assertQueue(QUEUE, { durable: true });
  await channel.assertQueue(deadLetterQueue, { durable: true });
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
