import { type ScompTransport } from '@scomp/core'

export function createRabbitMqTransport(): ScompTransport {
  throw new Error('RabbitMQ transport is not implemented yet. Use createInprocessTransport for now.');
}
