import {
  composeScompFragments,
  createScompFragment,
  createScompService,
} from "../src/builder";
import { createContractToken } from "../src/contract-token";

interface GroupedTypesContract {
  getUser(input: { id: number }): Promise<{ id: number }>;
  notifyLogin(input: { id: number }): Promise<void>;
  liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
}

const usersToken = createContractToken<GroupedTypesContract>("users");

createScompService(usersToken).implement({
  requests: {
    getUser: async ({ id }) => ({ id }),
  },
  signals: {
    notifyLogin: async () => {
      return;
    },
  },
  feeds: {
    liveUsers: async function* ({ room }) {
      yield { id: room.length };
    },
  },
});

createScompService(usersToken).implement({
  requests: {
    getUser: async ({ id }) => ({ id }),
  },
  signals: {
    notifyLogin: async () => {
      return;
    },
  },
  feeds: {
    liveUsers: {
      strategy: "fanout",
      handler: async function* ({ room }) {
        yield { id: room.length };
      },
    },
  },
});

const userRequests = createScompFragment<GroupedTypesContract>(
  "users",
).implement({
  requests: {
    getUser: async ({ id }) => ({ id }),
  },
});

const userSignals = createScompFragment<GroupedTypesContract>(
  "users",
).implement({
  signals: {
    notifyLogin: async () => {
      return;
    },
  },
});

composeScompFragments(userRequests, userSignals);

const userFeeds = createScompFragment<GroupedTypesContract>("users").implement({
  feeds: {
    liveUsers: async function* ({ room }) {
      yield { id: room.length };
    },
  },
});

composeScompFragments(userRequests, userSignals, userFeeds);

const duplicateUserRequests = createScompFragment<GroupedTypesContract>(
  "users",
).implement({
  requests: {
    getUser: async ({ id }) => ({ id }),
  },
});

// @ts-expect-error - duplicate methods across fragments are rejected
composeScompFragments(userRequests, duplicateUserRequests);

const duplicateUserSignals = createScompFragment<GroupedTypesContract>(
  "users",
).implement({
  signals: {
    notifyLogin: async () => {
      return;
    },
  },
});

// @ts-expect-error - duplicate methods are rejected even when only one fragment duplicates
composeScompFragments(userRequests, userSignals, duplicateUserSignals);

createScompService(usersToken).implement({
  getUser: async ({ id }) => ({ id }),
  notifyLogin: async () => {
    return;
  },
  liveUsers: async function* () {
    yield { id: 1 };
  },
});

// @ts-expect-error - strict services reject unknown flat methods
createScompService(usersToken).implement({
  getUser: async ({ id }) => ({ id }),
  notifyLogin: async () => {
    return;
  },
  liveUsers: async function* () {
    yield { id: 1 };
  },
  unknownMethod: async () => "nope",
});

createScompFragment<GroupedTypesContract>("users").implement({
  requests: {
    getUser: async ({ id }) => ({ id }),
  },
});

createScompFragment<GroupedTypesContract>("users").implement({
  signals: {
    notifyLogin: async () => {
      return;
    },
  },
});

createScompFragment<GroupedTypesContract>("users").implement({
  getUser: async ({ id }) => ({ id }),
});

createScompFragment<GroupedTypesContract>("users").implement({
  requests: {
    // @ts-expect-error - notifyLogin is a signal and cannot be in requests
    notifyLogin: async () => {
      return;
    },
  },
});

createScompFragment<GroupedTypesContract>("users").implement({
  signals: {
    // @ts-expect-error - signal handlers must return void | Promise<void>
    notifyLogin: async ({ id }) => ({ id }),
  },
});

createScompService(usersToken).implement({
  requests: {
    // @ts-expect-error - notifyLogin is a signal and cannot be in requests
    notifyLogin: async () => {
      return;
    },
  },
  signals: {
    notifyLogin: async () => {
      return;
    },
  },
  feeds: {
    liveUsers: async function* () {
      yield { id: 1 };
    },
  },
});

// @ts-expect-error - strict grouped services reject unknown grouped methods
createScompService(usersToken).implement({
  requests: {
    getUser: async ({ id }) => ({ id }),
    unknownMethod: async () => ({ id: 0 }),
  },
  signals: {
    notifyLogin: async () => {
      return;
    },
  },
  feeds: {
    liveUsers: async function* () {
      yield { id: 1 };
    },
  },
});

createScompService(usersToken).implement({
  requests: {
    getUser: async ({ id }) => ({ id }),
  },
  signals: {
    // @ts-expect-error - signal handlers must return void | Promise<void>
    notifyLogin: async ({ id }) => ({ id }),
  },
  feeds: {
    liveUsers: async function* () {
      yield { id: 1 };
    },
  },
});

// @ts-expect-error - strict services must implement all contract methods (missing liveUsers)
createScompService(usersToken).implement({
  getUser: async ({ id }) => ({ id }),
  notifyLogin: async () => {
    return;
  },
});

// @ts-expect-error - strict grouped services must implement all contract methods (missing liveUsers feed)
createScompService(usersToken).implement({
  requests: {
    getUser: async ({ id }) => ({ id }),
  },
  signals: {
    notifyLogin: async () => {
      return;
    },
  },
});

// @ts-expect-error - strict grouped services must implement all contract methods (missing notifyLogin signal)
createScompService(usersToken).implement({
  requests: {
    getUser: async ({ id }) => ({ id }),
  },
  feeds: {
    liveUsers: async function* () {
      yield { id: 1 };
    },
  },
});
