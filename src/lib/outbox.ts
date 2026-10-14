import { prisma } from "./prisma";
import { publish } from "./broker";

type OutboxTx = {
  eventOutbox: { create: (args: { data: { event_type: string; payload: object } }) => Promise<unknown> };
};

export type PaymentEventType = "payment.completed";

/**
 * Encola un evento DENTRO de la transacción del llamador: el cobro y su
 * evento se confirman juntos. Nace `pending`; solo el dispatcher lo marca
 * `sent` tras el confirm de RabbitMQ.
 */
export async function enqueueOutboxEvent(tx: OutboxTx, eventType: PaymentEventType, payload: object): Promise<void> {
  await tx.eventOutbox.create({ data: { event_type: eventType, payload } });
}

/** Publica pendientes en orden; se detiene ante el primer fallo (reintenta en el próximo tick). */
export async function flushOutbox(max = 100, publisher = publish): Promise<number> {
  const rows = await prisma.eventOutbox.findMany({
    where: { status: "pending" },
    orderBy: { created_at: "asc" },
    take: max,
  });
  let delivered = 0;
  for (const row of rows) {
    try {
      await publisher(row.event_type, row.payload);
    } catch (err) {
      await prisma.eventOutbox.update({
        where: { event_id: row.event_id },
        data: { attempts: { increment: 1 } },
      });
      console.error(`[outbox] no se pudo publicar ${row.event_type} ${row.event_id}`, err);
      break;
    }
    await prisma.eventOutbox.update({
      where: { event_id: row.event_id },
      data: { status: "sent", sent_at: new Date(), attempts: { increment: 1 } },
    });
    delivered += 1;
  }
  return delivered;
}

/** Drenaje periódico. Solo con RABBITMQ_URL; sin broker los eventos quedan pending. */
export function startOutboxDispatcher(intervalMs = 5_000): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await flushOutbox();
    } catch (err) {
      console.error("[outbox] flush falló", err);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return timer;
}
