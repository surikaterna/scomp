import {
  composeScompFragments,
  createContractToken,
  createScompFragment,
  createScompService,
  type CompiledRouter,
} from "@scompr/core";
import { createRabbitMqTransport, type RabbitMQTransportConfig } from "@scompr/transport-rabbitmq";
import type { DemoApiContract, LiveTickerInput, LiveTickerTick } from "../shared/api.contract";

const usersToken = createContractToken<DemoApiContract["users"]>("users");

export const usersService = createScompService(usersToken).implement({
  requests: {
    getUser: {
      parser: (payload): { id: number } => {
        const input = payload as { id: number };
        return { id: Number(input.id) };
      },
      handler: async (input) => ({
        id: input.id,
        name: `user-${input.id}`,
      }),
    },
  },
  signals: {
    notifyLogin: {
      parser: (payload): { userId: number; at: string } => {
        const input = payload as { userId: number; at: string };
        return {
          userId: Number(input.userId),
          at: String(input.at),
        };
      },
      handler: async (input) => {
        console.log(`[signal] user login notified`, input);
      },
    },
  },
  feeds: {
    liveTicker: {
      strategy: "fanout",
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
              at: new Date().toISOString(),
            };
          }
        } finally {
          console.log(`[feed] teardown for channel`, input.channel);
        }
      },
    },
  },
});

export const usersRequestsFragment = createScompFragment<DemoApiContract["users"]>("users").implement({
  requests: {
    getUser: {
      parser: (payload): { id: number } => {
        const input = payload as { id: number };
        return { id: Number(input.id) };
      },
      handler: async (input) => ({
        id: input.id,
        name: `user-${input.id}`,
      }),
    },
  },
});

export const usersSignalsFragment = createScompFragment<DemoApiContract["users"]>("users").implement({
  signals: {
    notifyLogin: {
      parser: (payload): { userId: number; at: string } => {
        const input = payload as { userId: number; at: string };
        return {
          userId: Number(input.userId),
          at: String(input.at),
        };
      },
      handler: async (input) => {
        console.log(`[signal] user login notified`, input);
      },
    },
  },
});

export const usersFeedsFragment = createScompFragment<DemoApiContract["users"]>("users").implement({
  feeds: {
    liveTicker: {
      strategy: "fanout",
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
              at: new Date().toISOString(),
            };
          }
        } finally {
          console.log(`[feed] teardown for channel`, input.channel);
        }
      },
    },
  },
});

export const usersComposedFragment = composeScompFragments(
  usersRequestsFragment,
  usersSignalsFragment,
  usersFeedsFragment,
);

export function getDemoRouter(): CompiledRouter {
  return usersComposedFragment.router;
}

export async function startDemoServer(config: RabbitMQTransportConfig) {
  const transport = createRabbitMqTransport(config);
  await transport.registerRoutes(getDemoRouter());
  return transport;
}
