import { createContractToken, createScompService } from "@scompr/core";
import { createScompClient } from "@scompr/client";
import { createInprocessTransport } from "@scompr/transport-inprocess";
import { log } from "./log";

// --- Contract Definition ---
interface UserServiceContract {
  getUser(id: number): Promise<{ id: number; name: string }>;
  notifyLogin(userId: number): void;
  liveUsers(filter: { online: boolean }): AsyncIterable<{ id: number; name: string; ts: number }>;
}

const UserService = createContractToken<UserServiceContract>("users");

// --- Service Implementation ---
const MOCK_USERS = [
  { id: 1, name: "Alice" },
  { id: 7, name: "Bob" },
  { id: 13, name: "Charlie" },
];

const service = createScompService(UserService).implement({
  requests: {
    getUser(id: number) {
      const user = MOCK_USERS.find((u) => u.id === id) ?? { id, name: `User#${id}` };
      return Promise.resolve(user);
    },
  },
  signals: {
    notifyLogin(userId: number) {
      log("service", "signal", `notifyLogin received for userId=${userId}`);
    },
  },
  feeds: {
    liveUsers(_filter: { online: boolean }) {
      let running = true;
      let index = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (!running) return { done: true as const, value: undefined };
              await new Promise((r) => setTimeout(r, 600));
              if (!running) return { done: true as const, value: undefined };
              const user = MOCK_USERS[index % MOCK_USERS.length];
              index++;
              return { done: false, value: { ...user, ts: Date.now() } };
            },
            async return() {
              running = false;
              return { done: true as const, value: undefined };
            },
          };
        },
      };
    },
  },
});

// --- Transport + Client ---
const transport = createInprocessTransport();
transport.registerRoutes(service.router);

const client = createScompClient<UserServiceContract>({
  transport,
  routeHints: {
    "users.getUser": "request",
    "users.notifyLogin": "signal",
    "users.liveUsers": "feed",
  },
});

// --- Display the code ---
const codeEl = document.getElementById("code-display");
if (codeEl) {
  codeEl.textContent = `interface UserServiceContract {
  getUser(id: number): Promise<{ id: number; name: string }>;
  notifyLogin(userId: number): void;
  liveUsers(filter): AsyncIterable<{ id; name; ts }>;
}

const service = createScompService(UserService).implement({
  requests: { getUser(id) { ... } },
  signals: { notifyLogin(userId) { ... } },
  feeds:   { liveUsers(filter) { ... } },
});

const transport = createInprocessTransport();
transport.registerRoutes(service.router);
const client = createScompClient<UserServiceContract>({ transport });`;
}

// --- Wire up buttons ---
let feedIterator: AsyncIterator<{ id: number; name: string; ts: number }> | null = null;
let feedRunning = false;

document.getElementById("btn-request")?.addEventListener("click", async () => {
  log("client", "request", "→ users.getUser(7)");
  const result = await client.getUser(7);
  log("client", "request", `← ${JSON.stringify(result)}`);
});

document.getElementById("btn-signal")?.addEventListener("click", async () => {
  log("client", "signal", "→ users.notifyLogin(42)");
  await client.notifyLogin(42);
  log("client", "signal", "← (fire-and-forget acknowledged)");
});

document.getElementById("btn-feed-start")?.addEventListener("click", async () => {
  if (feedRunning) return;
  feedRunning = true;
  const btnStart = document.getElementById("btn-feed-start") as HTMLButtonElement;
  const btnStop = document.getElementById("btn-feed-stop") as HTMLButtonElement;
  btnStart.disabled = true;
  btnStop.disabled = false;

  log("client", "feed", "→ users.liveUsers({ online: true }) [subscribing]");
  const feed = client.liveUsers({ online: true });
  const iterator = feed[Symbol.asyncIterator]();
  feedIterator = iterator;

  try {
    while (feedRunning) {
      const { done, value } = await iterator.next();
      if (done) break;
      log("client", "feed", `← chunk: ${JSON.stringify(value)}`);
    }
  } catch (err) {
    log("client", "error", `Feed error: ${err}`);
  }

  log("client", "feed", "← [stream ended]");
  btnStart.disabled = false;
  btnStop.disabled = true;
});

document.getElementById("btn-feed-stop")?.addEventListener("click", () => {
  feedRunning = false;
  if (feedIterator?.return) {
    feedIterator.return(undefined);
  }
  feedIterator = null;
});
