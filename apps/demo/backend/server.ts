import { createScompService, type CompiledRouter } from '@scomp/core';
import { createRabbitMqTransport, type RabbitMQTransportConfig } from '@scomp/transport-rabbitmq';
import type { DemoApiContract, LiveTickerInput, LiveTickerTick } from '../shared/api.contract';

const usersService = createScompService<DemoApiContract['users']>('users').implement({
  getUser: {
    kind: 'request',
    parser: (payload): { id: number } => {
      const input = payload as { id: number };
      return { id: Number(input.id) };
    },
    handler: async (input) => ({
      id: input.id,
      name: `user-${input.id}`
    })
  },
  notifyLogin: {
    kind: 'signal',
    parser: (payload): { userId: number; at: string } => {
      const input = payload as { userId: number; at: string };
      return {
        userId: Number(input.userId),
        at: String(input.at)
      };
    },
    handler: async (input) => {
      console.log(`[signal] user login notified`, input);
    }
  },
  liveTicker: {
    kind: 'feed',
    strategy: 'fanout',
    hashKey: (input: LiveTickerInput) => input.channel,
    handler: async function* (input: LiveTickerInput): AsyncIterable<LiveTickerTick> {
      let sequence = 0;
      try {
        while (true) {
          sequence += 1;
          await new Promise((resolve) => setTimeout(resolve, 500));
          yield {
            channel: input.channel,
            sequence,
            at: new Date().toISOString()
          };
        }
      } finally {
        console.log(`[feed] teardown for channel`, input.channel);
      }
    }
  }
});

export function getDemoRouter(): CompiledRouter {
  return usersService.router;
}

export async function startDemoServer(config: RabbitMQTransportConfig) {
  const transport = createRabbitMqTransport(config);
  await transport.listen(getDemoRouter());
  return transport;
}
