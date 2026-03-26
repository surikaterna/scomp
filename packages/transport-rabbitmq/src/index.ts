import { createCore } from '@scomp/core'

export const createRabbitMqTransport = () => ({
  core: createCore(),
  transport: 'rabbitmq'
})
