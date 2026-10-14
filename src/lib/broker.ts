import amqplib, { ChannelModel, ConfirmChannel } from "amqplib";

const EXCHANGE = "hotelsync.events";
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

let confirmChannel: ConfirmChannel | null = null;
let connecting: Promise<ConfirmChannel> | null = null;

function rabbitUrl(): string {
  return process.env.RABBITMQ_URL || "amqp://localhost:5672";
}

/**
 * Conexión única y perezosa con reconexión exponencial y publisher confirms.
 * Solo la usa el dispatcher del outbox (en segundo plano), nunca una request:
 * si RabbitMQ cae, el cobro no se cuelga esperando al broker.
 */
export async function connect(): Promise<ConfirmChannel> {
  if (confirmChannel) return confirmChannel;

  connecting ??= (async () => {
    let attempt = 0;
    for (;;) {
      try {
        const conn: ChannelModel = await amqplib.connect(rabbitUrl());
        conn.on("error", () => {
          /* listener obligatorio; 'close' dispara la reconexión */
        });
        conn.on("close", () => {
          confirmChannel = null;
          connecting = null;
        });
        const channel = await conn.createConfirmChannel();
        await channel.assertExchange(EXCHANGE, "topic", { durable: true });
        confirmChannel = channel;
        return channel;
      } catch {
        attempt += 1;
        const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
        console.warn(`[broker] RabbitMQ no disponible (intento ${attempt}), reintento en ${delay}ms`);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  })();
  return connecting;
}

/** Publica un mensaje persistente y espera el confirm del broker. */
export async function publish(routingKey: string, payload: unknown): Promise<void> {
  const channel = await connect();
  await new Promise<void>((resolve, reject) => {
    channel.publish(
      EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true, contentType: "application/json" },
      (err) => (err ? reject(err) : resolve())
    );
  });
}
