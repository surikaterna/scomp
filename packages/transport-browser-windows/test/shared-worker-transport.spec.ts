import { BrowserWindowsSharedWorkerBroker } from "../src/shared-worker-broker";
import { BrowserWindowsTransport } from "../src/transport-browser-windows";

class MockPort {
  peer?: MockPort;
  readonly listeners = new Set<(event: { data: any }) => void>();

  postMessage(message: any): void {
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

  addEventListener(
    _type: "message",
    listener: (event: { data: any }) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: { data: any }) => void,
  ): void {
    this.listeners.delete(listener);
  }

  start(): void {
    // no-op
  }

  close(): void {
    this.listeners.clear();
  }
}

class MockSharedWorker {
  readonly port: MockPort;

  constructor(
    _scriptUrl: string,
    _optionsOrName: { name?: string } | string | undefined,
  ) {
    const runtimePort = new MockPort();
    const brokerPort = new MockPort();
    runtimePort.peer = brokerPort;
    brokerPort.peer = runtimePort;
    this.port = runtimePort;
    mockWorkerBroker.attachPort(brokerPort);
  }
}

let mockWorkerBroker: BrowserWindowsSharedWorkerBroker;

describe("BrowserWindowsTransport shared worker", () => {
  beforeEach(() => {
    mockWorkerBroker = new BrowserWindowsSharedWorkerBroker();
  });

  test("request round-trip resolves response payload", async () => {
    const host = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });
    host.listen({
      "svc.double": {
        route: "svc.double",
        kind: "request",
        handler(payload: unknown) {
          return { value: Number((payload as { value: number }).value) * 2 };
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    const response = await invoke.request("svc.double", { value: 7 });
    expect(response).toEqual({ value: 14 });

    invoke.close();
    host.close();
  });

  test("signal fanout reaches all registered hosts", async () => {
    const calls: Array<string> = [];

    const hostA = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });
    hostA.listen({
      "svc.ping": {
        route: "svc.ping",
        kind: "signal",
        async handler(payload: unknown) {
          calls.push(`a:${String((payload as { value: string }).value)}`);
        },
      },
    });

    const hostB = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });
    hostB.listen({
      "svc.ping": {
        route: "svc.ping",
        kind: "signal",
        async handler(payload: unknown) {
          calls.push(`b:${String((payload as { value: string }).value)}`);
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    await invoke.signal("svc.ping", { value: "ok" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(expect.arrayContaining(["a:ok", "b:ok"]));
    expect(calls).toHaveLength(2);

    invoke.close();
    hostA.close();
    hostB.close();
  });

  test("feed start/chunk/stop lifecycle streams values", async () => {
    const host = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    host.listen({
      "svc.stream": {
        route: "svc.stream",
        kind: "feed",
        handler() {
          return {
            async *[Symbol.asyncIterator]() {
              yield 1;
              yield 2;
            },
          };
        },
      },
    });

    const invoke = new BrowserWindowsTransport({
      sharedWorkerCtor: MockSharedWorker as any,
    });

    const values: Array<number> = [];
    for await (const chunk of invoke.feed("svc.stream", { from: "test" })) {
      values.push(chunk as number);
    }

    expect(values).toEqual([1, 2]);

    invoke.close();
    host.close();
  });
});
