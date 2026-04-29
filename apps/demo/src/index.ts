import { composeScompFragments, createScompFragment, createScompService } from "@scomp/core";

interface LocalUsersContract {
  getUser(input: { id: number }): Promise<{ id: number; name: string }>;
  notifyLogin(input: { id: number; at: string }): Promise<void>;
  liveUsers(input: { room: string }): AsyncIterable<{ id: number; at: string }>;
}

function main() {
  const strictService = createScompService<LocalUsersContract>("users").implement({
    requests: {
      getUser: async ({ id }) => ({ id, name: `user-${id}` }),
    },
    signals: {
      notifyLogin: async ({ id, at }) => {
        console.log("notifyLogin", { id, at });
      },
    },
    feeds: {
      liveUsers: {
        strategy: "fanout",
        handler: async function* ({ room }) {
          yield { id: room.length, at: new Date().toISOString() };
        },
      },
    },
  });

  const requestsFragment = createScompFragment<LocalUsersContract>("users").implement({
    requests: {
      getUser: async ({ id }) => ({ id, name: `user-${id}` }),
    },
  });

  const signalsFragment = createScompFragment<LocalUsersContract>("users").implement({
    signals: {
      notifyLogin: async ({ id, at }) => {
        console.log("notifyLogin(fragment)", { id, at });
      },
    },
  });

  const feedsFragment = createScompFragment<LocalUsersContract>("users").implement({
    feeds: {
      liveUsers: async function* ({ room }) {
        yield { id: room.length, at: new Date().toISOString() };
      },
    },
  });

  const composedFragment = composeScompFragments(requestsFragment, signalsFragment, feedsFragment);

  console.log("strict grouped routes:", Object.keys(strictService.router).sort());
  console.log("composed fragment routes:", Object.keys(composedFragment.router).sort());
}

main();
