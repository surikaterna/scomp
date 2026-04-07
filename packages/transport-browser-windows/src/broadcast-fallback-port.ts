import type { BrowserWindowsProtocolMessage } from "./protocol";

export interface BrokerPortLike {
  postMessage(message: BrowserWindowsProtocolMessage): void;
  addEventListener(
    type: "message",
    listener: (event: { data: BrowserWindowsProtocolMessage }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: BrowserWindowsProtocolMessage }) => void,
  ): void;
  start?(): void;
  emitIncoming(message: BrowserWindowsProtocolMessage): void;
}

export class InMemoryBrokerPort implements BrokerPortLike {
  private readonly listeners = new Set<
    (event: { data: BrowserWindowsProtocolMessage }) => void
  >();

  constructor(
    private readonly sender: (message: BrowserWindowsProtocolMessage) => void,
  ) {}

  postMessage(message: BrowserWindowsProtocolMessage): void {
    this.sender(message);
  }

  addEventListener(
    _type: "message",
    listener: (event: { data: BrowserWindowsProtocolMessage }) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: { data: BrowserWindowsProtocolMessage }) => void,
  ): void {
    this.listeners.delete(listener);
  }

  start(): void {
    // no-op
  }

  emitIncoming(message: BrowserWindowsProtocolMessage): void {
    for (const listener of this.listeners) {
      listener({ data: message });
    }
  }
}
