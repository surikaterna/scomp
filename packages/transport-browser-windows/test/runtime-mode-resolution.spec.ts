import { createRuntimeConnector } from "../src/shared-worker-connector";
import { FakeBroadcastChannel } from "./test-doubles/fake-broadcast-channel";
import { FakeSilentSharedWorker } from "./test-doubles/fake-shared-worker";

class MissingBroadcastChannel {
  constructor(_name: string) {
    throw new Error("BroadcastChannel unavailable in test runtime.");
  }
}

type ModeCase = {
  name: string;
  mode: "auto" | "shared-worker" | "broadcast-channel";
  sharedWorkerCtor?: typeof FakeSilentSharedWorker;
  broadcastChannelCtor?: typeof FakeBroadcastChannel | typeof MissingBroadcastChannel;
  sharedWorkerStrict?: boolean;
  expectedMode?: "shared-worker" | "broadcast-channel";
  expectedError?: RegExp;
};

const CASES: ReadonlyArray<ModeCase> = [
  {
    name: "auto prefers shared-worker when available",
    mode: "auto",
    sharedWorkerCtor: FakeSilentSharedWorker,
    broadcastChannelCtor: FakeBroadcastChannel,
    expectedMode: "shared-worker",
  },
  {
    name: "auto falls back to broadcast-channel when shared-worker unavailable",
    mode: "auto",
    broadcastChannelCtor: FakeBroadcastChannel,
    expectedMode: "broadcast-channel",
  },
  {
    name: "auto throws when both shared-worker and broadcast-channel are unavailable",
    mode: "auto",
    broadcastChannelCtor: MissingBroadcastChannel,
    expectedError: /broadcast-channel-unavailable/i,
  },
  {
    name: "shared-worker mode uses shared-worker when available",
    mode: "shared-worker",
    sharedWorkerCtor: FakeSilentSharedWorker,
    broadcastChannelCtor: FakeBroadcastChannel,
    expectedMode: "shared-worker",
  },
  {
    name: "shared-worker mode falls back by default when shared-worker unavailable",
    mode: "shared-worker",
    broadcastChannelCtor: FakeBroadcastChannel,
    expectedMode: "broadcast-channel",
  },
  {
    name: "shared-worker strict mode fails fast when shared-worker unavailable",
    mode: "shared-worker",
    sharedWorkerStrict: true,
    broadcastChannelCtor: FakeBroadcastChannel,
    expectedError: /shared-worker-unavailable/i,
  },
  {
    name: "shared-worker mode throws when fallback broadcast-channel is unavailable",
    mode: "shared-worker",
    broadcastChannelCtor: MissingBroadcastChannel,
    expectedError: /broadcast-channel-unavailable/i,
  },
  {
    name: "broadcast-channel mode always uses broadcast-channel",
    mode: "broadcast-channel",
    sharedWorkerCtor: FakeSilentSharedWorker,
    broadcastChannelCtor: FakeBroadcastChannel,
    expectedMode: "broadcast-channel",
  },
  {
    name: "broadcast-channel mode fails when broadcast-channel unavailable",
    mode: "broadcast-channel",
    sharedWorkerCtor: FakeSilentSharedWorker,
    broadcastChannelCtor: MissingBroadcastChannel,
    expectedError: /broadcast-channel-unavailable/i,
  },
];

describe("runtime mode resolution", () => {
  beforeEach(() => {
    FakeBroadcastChannel.reset();
  });

  test.each(CASES)("$name", (modeCase) => {
    if (modeCase.expectedError) {
      expect(() => {
        createRuntimeConnector(
          {
            mode: modeCase.mode,
            sharedWorkerCtor: modeCase.sharedWorkerCtor,
            broadcastChannelCtor: modeCase.broadcastChannelCtor,
            sharedWorkerStrict: modeCase.sharedWorkerStrict,
            channelName: `mode-${modeCase.mode}`,
          },
          `participant-${modeCase.mode}-${Date.now()}`,
        );
      }).toThrow(modeCase.expectedError);
      return;
    }

    const connector = createRuntimeConnector(
      {
        mode: modeCase.mode,
        sharedWorkerCtor: modeCase.sharedWorkerCtor,
        broadcastChannelCtor: modeCase.broadcastChannelCtor,
        sharedWorkerStrict: modeCase.sharedWorkerStrict,
        channelName: `mode-${modeCase.mode}`,
      },
      `participant-${modeCase.mode}-${Date.now()}`,
    );

    expect(connector.activeMode).toBe(modeCase.expectedMode);
    connector.close();
  });
});
