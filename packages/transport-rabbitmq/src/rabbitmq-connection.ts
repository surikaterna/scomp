import amqp, { type ChannelModel } from "amqplib";
import type {
  RabbitMQTransportRetryConfig,
  RabbitMQTransportEvent,
} from "./types";

export async function connectWithRetry(
  config: RabbitMQTransportRetryConfig & { url: string },
  emitEvent: (event: RabbitMQTransportEvent) => void,
): Promise<ChannelModel> {
  const maxAttempts = config.maxAttempts ?? 6;
  const baseDelayMs = config.baseDelayMs ?? 250;
  const maxDelayMs = config.maxDelayMs ?? 8_000;

  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      if (attempt > 1) {
        emitEvent({ type: "connection_reconnect", attempt });
      }
      return await amqp.connect(config.url);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) {
        break;
      }

      const jitter = Math.floor(Math.random() * 100);
      const delay = Math.min(
        maxDelayMs,
        baseDelayMs * 2 ** (attempt - 1) + jitter,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(
    `Unable to connect to RabbitMQ after ${maxAttempts} attempts: ${String(lastError)}`,
  );
}
