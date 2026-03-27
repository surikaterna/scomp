import { type ScompTransport } from '@scomp/core'

/**
 * Creates a RabbitMQ-backed transport.
 *
 * @remarks
 * This transport is currently a placeholder and throws until implemented.
 */
export function createRabbitMqTransport(): ScompTransport {
  throw new Error('RabbitMQ transport is not implemented yet. Use createInprocessTransport for now.');
}
