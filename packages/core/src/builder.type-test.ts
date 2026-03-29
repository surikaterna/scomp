import { createScompFragment, createScompService } from './builder';

interface GroupedTypesContract {
  getUser(input: { id: number }): Promise<{ id: number }>;
  notifyLogin(input: { id: number }): Promise<void>;
  liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
}

createScompService<GroupedTypesContract>('users').implement({
  requests: {
    getUser: async ({ id }) => ({ id })
  },
  signals: {
    notifyLogin: async () => {
      return;
    }
  },
  feeds: {
    liveUsers: async function* ({ room }) {
      yield { id: room.length };
    }
  }
});

createScompService<GroupedTypesContract>('users').implement({
  getUser: async ({ id }) => ({ id }),
  notifyLogin: async () => {
    return;
  },
  liveUsers: async function* () {
    yield { id: 1 };
  }
});

createScompFragment<GroupedTypesContract>('users').implement({
  requests: {
    getUser: async ({ id }) => ({ id })
  }
});

createScompFragment<GroupedTypesContract>('users').implement({
  signals: {
    notifyLogin: async () => {
      return;
    }
  }
});

createScompFragment<GroupedTypesContract>('users').implement({
  getUser: async ({ id }) => ({ id })
});

createScompFragment<GroupedTypesContract>('users').implement({
  requests: {
    // @ts-expect-error - notifyLogin is a signal and cannot be in requests
    notifyLogin: async () => {
      return;
    }
  }
});

createScompFragment<GroupedTypesContract>('users').implement({
  signals: {
    // @ts-expect-error - signal handlers must return void | Promise<void>
    notifyLogin: async ({ id }) => ({ id })
  }
});

createScompService<GroupedTypesContract>('users').implement({
  requests: {
    // @ts-expect-error - notifyLogin is a signal and cannot be in requests
    notifyLogin: async () => {
      return;
    }
  },
  signals: {
    notifyLogin: async () => {
      return;
    }
  },
  feeds: {
    liveUsers: async function* () {
      yield { id: 1 };
    }
  }
});

createScompService<GroupedTypesContract>('users').implement({
  requests: {
    getUser: async ({ id }) => ({ id })
  },
  signals: {
    // @ts-expect-error - signal handlers must return void | Promise<void>
    notifyLogin: async ({ id }) => ({ id })
  },
  feeds: {
    liveUsers: async function* () {
      yield { id: 1 };
    }
  }
});

// @ts-expect-error - strict services must implement all contract methods (missing liveUsers)
createScompService<GroupedTypesContract>('users').implement({
  getUser: async ({ id }) => ({ id }),
  notifyLogin: async () => {
    return;
  }
});

// @ts-expect-error - strict grouped services must implement all contract methods (missing liveUsers feed)
createScompService<GroupedTypesContract>('users').implement({
  requests: {
    getUser: async ({ id }) => ({ id })
  },
  signals: {
    notifyLogin: async () => {
      return;
    }
  }
});
