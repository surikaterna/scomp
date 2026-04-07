type MessageEventLike = { data: unknown };
type MessageListener = (event: MessageEventLike) => void;

export class FakeBroadcastChannel {
  private static channels = new Map<string, Set<FakeBroadcastChannel>>();
  private readonly listeners = new Set<MessageListener>();

  constructor(private readonly name: string) {
    const entries = FakeBroadcastChannel.channels.get(name) ?? new Set();
    entries.add(this);
    FakeBroadcastChannel.channels.set(name, entries);
  }

  static reset(): void {
    FakeBroadcastChannel.channels.clear();
  }

  postMessage(message: unknown): void {
    const entries = FakeBroadcastChannel.channels.get(this.name);
    if (!entries) {
      return;
    }

    for (const channel of entries) {
      if (channel === this) {
        continue;
      }

      queueMicrotask(() => {
        for (const listener of channel.listeners) {
          listener({ data: message });
        }
      });
    }
  }

  addEventListener(_type: "message", listener: MessageListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: MessageListener): void {
    this.listeners.delete(listener);
  }

  close(): void {
    const entries = FakeBroadcastChannel.channels.get(this.name);
    entries?.delete(this);
    if (entries && entries.size === 0) {
      FakeBroadcastChannel.channels.delete(this.name);
    }
    this.listeners.clear();
  }
}
