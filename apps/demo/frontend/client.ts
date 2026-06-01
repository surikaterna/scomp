import { createScompClient, type ClientRouteHints } from "@scompr/client";
import { createRabbitMqTransport, type RabbitMQTransportConfig } from "@scompr/transport-rabbitmq";
import type { DemoApiContract } from "../shared/api.contract";

const routeHints: ClientRouteHints = {
  "users.getUser": "request",
  "users.notifyLogin": "signal",
  "users.liveTicker": "feed",
};

export function createDemoClient(config: RabbitMQTransportConfig) {
  const transport = createRabbitMqTransport(config);
  const client = createScompClient<DemoApiContract>({
    transport,
    routeHints,
  });

  return {
    client,
    transport,
  };
}
