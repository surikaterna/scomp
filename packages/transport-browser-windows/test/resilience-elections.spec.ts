import { BrowserWindowsTransport } from "../src/transport-browser-windows";
import { FakeBroadcastChannel } from "./test-doubles/fake-broadcast-channel";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("browser windows resilience (election/failover/degraded)", () => {
  beforeEach(() => {
    FakeBroadcastChannel.reset();
  });

  test("broadcast election failover keeps routing and reports degraded health", async () => {
    const channelName = "resilience-failover";

    const firstLeader = new BrowserWindowsTransport({
      mode: "broadcast-channel",
      nodeId: "node-a",
      channelName,
      broadcastChannelCtor: FakeBroadcastChannel,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 30,
    });

    const host = new BrowserWindowsTransport({
      mode: "broadcast-channel",
      nodeId: "node-b",
      channelName,
      broadcastChannelCtor: FakeBroadcastChannel,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 30,
    });

    host.registerRoutes({
      "svc.identity": {
        route: "svc.identity",
        kind: "request",
        handler(payload: unknown) {
          return payload;
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      mode: "broadcast-channel",
      nodeId: "node-c",
      channelName,
      broadcastChannelCtor: FakeBroadcastChannel,
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 30,
    });

    await flushMicrotasks();
    await sleep(50);
    await expect(
      invoke.request("svc.identity", { phase: "before" }),
    ).resolves.toEqual({
      phase: "before",
    });

    firstLeader.close();

    await sleep(70);
    await expect(
      invoke.request("svc.identity", { phase: "after" }),
    ).resolves.toEqual({
      phase: "after",
    });

    const reasonCodes = invoke
      .healthSnapshot()
      .reasons.map((reason) => reason.code);
    expect(reasonCodes).toContain("leader-failover");
    expect(invoke.healthSnapshot().status).toBe("degraded");

    invoke.close();
    host.close();
  });

  test("auto mode fallback records shared-worker-unavailable degraded reason", () => {
    const snapshots: Array<{ status: string; reasons: Array<string> }> = [];

    const transport = new BrowserWindowsTransport({
      mode: "auto",
      nodeId: "node-fallback",
      channelName: "resilience-fallback",
      sharedWorkerCtor: undefined,
      broadcastChannelCtor: FakeBroadcastChannel,
      health: {
        onSnapshot(snapshot) {
          snapshots.push({
            status: snapshot.status,
            reasons: snapshot.reasons.map((reason) => reason.code),
          });
        },
      },
    });

    const latest = snapshots[snapshots.length - 1];
    expect(transport.activeMode()).toBe("broadcast-channel");
    expect(latest?.status).toBe("degraded");
    expect(latest?.reasons).toContain("shared-worker-unavailable");

    transport.close();
  });
});
