/**
 * Type-level tests for compile-time contract validation.
 *
 * Valid contracts must compile without errors.
 * Invalid contracts must trigger @ts-expect-error annotations,
 * proving that the validation types catch them.
 */
import { createScompService, createScompFragment } from "../src/builder";
import { createContractToken } from "../src/contract-token";
import type {
  DiagnoseContract,
  IsValidContract,
  ValidContract,
} from "../src/builder-types";

// ---------------------------------------------------------------------------
// Helpers for type-level assertions
// ---------------------------------------------------------------------------

type Expect<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y
  ? 1
  : 2
  ? true
  : false;

// ---------------------------------------------------------------------------
// 1. Valid contracts compile without errors
// ---------------------------------------------------------------------------

interface RequestOnlyContract {
  getUser(input: { id: number }): Promise<{ id: number }>;
}

const requestToken = createContractToken<RequestOnlyContract>("requests");
createScompService(requestToken).implement({
  getUser: async ({ id }) => ({ id }),
});

interface SignalOnlyContract {
  notifyLogin(input: { id: number }): Promise<void>;
}

const signalToken = createContractToken<SignalOnlyContract>("signals");
createScompService(signalToken).implement({
  notifyLogin: async () => {
    return;
  },
});

interface FeedOnlyContract {
  liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
}

const feedToken = createContractToken<FeedOnlyContract>("feeds");
createScompService(feedToken).implement({
  feeds: {
    liveUsers: async function* () {
      yield { id: 1 };
    },
  },
});

interface MixedContract {
  getUser(input: { id: number }): Promise<{ id: number }>;
  notifyLogin(input: { id: number }): Promise<void>;
  liveUsers(input: { room: string }): AsyncIterable<{ id: number }>;
}

const mixedToken = createContractToken<MixedContract>("mixed");
createScompService(mixedToken).implement({
  requests: {
    getUser: async ({ id }) => ({ id }),
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

// ---------------------------------------------------------------------------
// 2. Empty contracts are valid (edge case)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface EmptyContract {}

type _EmptyIsValid = Expect<Equal<IsValidContract<EmptyContract>, true>>;

// ---------------------------------------------------------------------------
// 3. Sync-return methods produce diagnostic errors
// ---------------------------------------------------------------------------

interface SyncReturnContract {
  getUser(input: { id: number }): { id: number };
}

type _SyncDiagnosis = Expect<
  Equal<
    DiagnoseContract<SyncReturnContract>,
    {
      getUser: '⚠ "getUser" must return Promise<T>, AsyncIterable<T>, or void';
    }
  >
>;

type _SyncIsInvalid = Expect<Equal<IsValidContract<SyncReturnContract>, false>>;

// @ts-expect-error - sync return type requires a diagnosis argument
createScompService(createContractToken<SyncReturnContract>("sync"));

// @ts-expect-error - sync return type in fragment also requires a diagnosis argument
createScompFragment<SyncReturnContract>("sync-fragment");

// ---------------------------------------------------------------------------
// 4. Non-method properties are caught by ValidContract
// ---------------------------------------------------------------------------

interface NonMethodContract {
  version: string;
  getUser(input: { id: number }): Promise<{ id: number }>;
}

type _NonMethodMapped = Expect<
  Equal<
    ValidContract<NonMethodContract>,
    {
      version: never;
      getUser: (input: { id: number }) => Promise<{ id: number }>;
    }
  >
>;

type _NonMethodIsInvalid = Expect<
  Equal<IsValidContract<NonMethodContract>, false>
>;

// @ts-expect-error - non-method property (version: string) is not assignable to (...args) => unknown
createScompService(createContractToken<NonMethodContract>("non-method"));

// ---------------------------------------------------------------------------
// 5. Union return types produce diagnostic errors
// ---------------------------------------------------------------------------

interface UnionReturnContract {
  getUser(input: { id: number }): Promise<{ id: number }> | string;
}

type _UnionIsInvalid = Expect<
  Equal<IsValidContract<UnionReturnContract>, false>
>;

// @ts-expect-error - union return type is not a supported contract method
createScompService(createContractToken<UnionReturnContract>("union"));

// ---------------------------------------------------------------------------
// 6. Controlled feeds (AsyncIterable) work correctly
// ---------------------------------------------------------------------------

interface ControlledFeedContract {
  liveData(input: { key: string }): AsyncIterable<{ value: number }>;
}

type _FeedIsValid = Expect<
  Equal<IsValidContract<ControlledFeedContract>, true>
>;

const controlledFeedToken =
  createContractToken<ControlledFeedContract>("controlled");
createScompService(controlledFeedToken).implement({
  feeds: {
    liveData: async function* () {
      yield { value: 42 };
    },
  },
});

// ---------------------------------------------------------------------------
// 7. The diagnostic messages contain the method name
// ---------------------------------------------------------------------------

interface MultiMethodInvalid {
  goodMethod(input: { id: number }): Promise<{ id: number }>;
  badMethod(input: { id: number }): number;
  anotherBad(input: { id: number }): string;
}

type _MultiDiagnosis = Expect<
  Equal<
    DiagnoseContract<MultiMethodInvalid>,
    {
      goodMethod: (input: { id: number }) => Promise<{ id: number }>;
      badMethod: '⚠ "badMethod" must return Promise<T>, AsyncIterable<T>, or void';
      anotherBad: '⚠ "anotherBad" must return Promise<T>, AsyncIterable<T>, or void';
    }
  >
>;

// @ts-expect-error - contract has methods with invalid return types
createScompService(createContractToken<MultiMethodInvalid>("multi-invalid"));

// ---------------------------------------------------------------------------
// 8. void-returning methods are valid (fire-and-forget signals)
// ---------------------------------------------------------------------------

interface VoidContract {
  fire(input: { event: string }): void;
}

type _VoidIsValid = Expect<Equal<IsValidContract<VoidContract>, true>>;

const voidToken = createContractToken<VoidContract>("void");
createScompService(voidToken);

// ---------------------------------------------------------------------------
// 9. Fragment validation works the same way
// ---------------------------------------------------------------------------

// @ts-expect-error - sync return type in fragment requires a diagnosis argument
createScompFragment<SyncReturnContract>("sync-fragment-2");

createScompFragment<MixedContract>("valid-fragment").implement({
  getUser: async ({ id }) => ({ id }),
});
