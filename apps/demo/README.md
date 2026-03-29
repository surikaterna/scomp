# @scomp/demo

This demo shows the default SCOMP authoring flow:

- strict grouped service implementation via `createScompService`
- partial domain implementations via `createScompFragment`
- fragment composition via `composeScompFragments`

## Authoring model

`apps/demo/backend/server.ts` includes both forms:

1. `usersService`: strict grouped service with required sections:
   - `requests`
   - `signals`
   - `feeds`
2. `usersRequestsFragment`, `usersSignalsFragment`, `usersFeedsFragment`: partial fragments
3. `usersComposedFragment`: composed fragment router used by the running demo server

Both produce equivalent route kinds for the same contract methods.

## Run

```bash
bun turbo run start --filter=@scomp/demo
```

Requires RabbitMQ at `SCOMP_RABBITMQ_URL` (defaults to `amqp://localhost:5672`).
