type MessageEventLike = { data: unknown };
type MessageListener = (event: MessageEventLike) => void;

export class FakeMessagePort {
  peer?: FakeMessagePort;
  private readonly listeners = new Set<MessageListener>();

  postMessage(message: unknown): void {
    const target = this.peer;
    if (!target) {
      return;
    }

    queueMicrotask(() => {
      for (const listener of target.listeners) {
        listener({ data: message });
      }
    });
  }

  addEventListener(_type: "message", listener: MessageListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: MessageListener): void {
    this.listeners.delete(listener);
  }

  start(): void {
    // no-op for test double
  }

  close(): void {
    this.listeners.clear();
  }
}

export function createFakeSharedWorkerCtor(
  attachPort: (port: FakeMessagePort) => void,
): new (
  scriptUrl: string,
  optionsOrName?: { name?: string } | string,
) => { port: FakeMessagePort } {
  return class FakeSharedWorker {
    readonly port: FakeMessagePort;

    constructor(_scriptUrl: string, _optionsOrName: { name?: string } | string | undefined) {
      const runtimePort = new FakeMessagePort();
      const brokerPort = new FakeMessagePort();
      runtimePort.peer = brokerPort;
      brokerPort.peer = runtimePort;
      this.port = runtimePort;
      attachPort(brokerPort);
    }
  };
}

export class FakeSilentSharedWorker {
  readonly port = new FakeMessagePort();
}
