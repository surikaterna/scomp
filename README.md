# SCOMP

Typed service contract + transport toolkit.

## Default authoring model (strict + grouped)

SCOMP now defaults to **strict, grouped service authoring** with three operation sections:

- `requests`
- `signals`
- `feeds`

Use `createScompService` to define a full service. In strict mode, every contract method must be implemented and grouped under the correct section.

```ts
import { createScompService } from '@scomp/core';

interface UsersContract {
  getUser(input: { id: number }): Promise<{ id: number; name: string }>;
  notifyLogin(input: { id: number; at: string }): Promise<void>;
  liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
}

const usersService = createScompService<UsersContract>('users').implement({
  requests: {
    getUser: async ({ id }) => ({ id, name: `user-${id}` })
  },
  signals: {
    notifyLogin: async ({ id, at }) => {
      console.log('login', { id, at });
    }
  },
  feeds: {
    liveUsers: {
      strategy: 'fanout',
      handler: async function* () {
        yield { id: 1 };
      }
    }
  }
});
```

## Fragment composition flow

Use **fragments** for partial/domain-local implementation, then compose them with `composeScompFragments`.

```ts
import { createScompFragment, composeScompFragments } from '@scomp/core';

const usersRequests = createScompFragment<UsersContract>('users').implement({
  requests: {
    getUser: async ({ id }) => ({ id, name: `user-${id}` })
  }
});

const usersSignals = createScompFragment<UsersContract>('users').implement({
  signals: {
    notifyLogin: async () => {
      return;
    }
  }
});

const usersFeeds = createScompFragment<UsersContract>('users').implement({
  feeds: {
    liveUsers: async function* () {
      yield { id: 1 };
    }
  }
});

const usersRouterFragment = composeScompFragments(usersRequests, usersSignals, usersFeeds);
```

Fragment composition rejects duplicate methods across fragments.

## Demo

See `apps/demo` for end-to-end examples using grouped sections and fragments.

## WebSocket server package split (Bun vs Node)

The websocket server transport is now split by runtime:

- **Bun runtime (`Bun.serve`)**: `@scomp/transport-websocket-server`
- **Node runtime (`ws` + `http`)**: `@scomp/transport-websocket-server-node`

This is a breaking rename for Node users.

```ts
// Bun server usage
import { createWebSocketServerTransport } from '@scomp/transport-websocket-server';

// Node server usage (renamed package)
import { createWebSocketServerTransport } from '@scomp/transport-websocket-server-node';
```

If you previously imported Node server transport from `@scomp/transport-websocket-server`,
switch those imports to `@scomp/transport-websocket-server-node`.

See migration notes: [docs/migration-websocket-server-split.md](docs/migration-websocket-server-split.md)

## Wire format

Transport protocol reference:

- [docs/transport-json-protocol.md](docs/transport-json-protocol.md)
