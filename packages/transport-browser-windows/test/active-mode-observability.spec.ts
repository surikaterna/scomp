import { BrowserWindowsTransport } from "../src/transport-browser-windows";
import { FakeBroadcastChannel } from "./test-doubles/fake-broadcast-channel";
import { FakeSilentSharedWorker } from "./test-doubles/fake-shared-worker";

describe("active mode observability", () => {
  beforeEach(() => {
    FakeBroadcastChannel.reset();
  });

  test("activeMode and health snapshot expose shared-worker after initialization", () => {
    const transport = new BrowserWindowsTransport({
      mode: "auto",
      sharedWorkerCtor: FakeSilentSharedWorker,
      broadcastChannelCtor: FakeBroadcastChannel,
    });

    expect(transport.activeMode()).toBe("shared-worker");
    expect(transport.healthSnapshot().activeMode).toBe("shared-worker");

    transport.close();
  });

  test("fallback startup sets broadcast-channel as active mode and degraded health", () => {
    const transport = new BrowserWindowsTransport({
      mode: "auto",
      sharedWorkerCtor: undefined,
      broadcastChannelCtor: FakeBroadcastChannel,
      channelName: "active-mode-fallback",
    });

    const snapshot = transport.healthSnapshot();
    expect(transport.activeMode()).toBe("broadcast-channel");
    expect(snapshot.activeMode).toBe("broadcast-channel");
    expect(snapshot.status).toBe("degraded");
    expect(snapshot.reasons.some((reason) => reason.code === "shared-worker-unavailable")).toBe(true);

    transport.close();
  });
});
