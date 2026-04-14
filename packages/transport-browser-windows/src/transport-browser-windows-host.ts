import type {
  BrowserWindowsHostFeedStartMessage,
  BrowserWindowsHostFeedStopMessage,
  BrowserWindowsHostRequestMessage,
  BrowserWindowsHostSignalMessage,
} from "./protocol";
import type {
  HostedFeedState,
  RuntimeRoute,
} from "./transport-browser-windows-state";
import { routeOperation } from "./transport-browser-windows-state";
import { toAsyncIterable, toError } from "./transport-browser-windows-runtime";

interface HostContext {
  readonly participantId: string;
  readonly router: Record<string, RuntimeRoute>;
  readonly hostedFeeds: Map<string, HostedFeedState>;
  postMessage(message: unknown): void;
  assertInboundAllowed(
    route: string,
    operation: "request" | "signal" | "feed",
    payload: unknown,
    meta: unknown,
  ): Promise<void>;
}

export async function handleHostRequest(
  context: HostContext,
  message: BrowserWindowsHostRequestMessage,
): Promise<void> {
  const route = context.router[message.route];
  if (!route) {
    context.postMessage({
      type: "host_response",
      sourceId: context.participantId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      invokeId: message.invokeId,
      hostId: context.participantId,
      error: `No route handler registered for ${message.route}`,
      meta: message.meta,
    });
    return;
  }

  if (routeOperation(route) !== "request") {
    context.postMessage({
      type: "host_response",
      sourceId: context.participantId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      invokeId: message.invokeId,
      hostId: context.participantId,
      error: `Route ${message.route} does not support request operation`,
      meta: message.meta,
    });
    return;
  }

  try {
    await context.assertInboundAllowed(
      message.route,
      "request",
      message.payload,
      message.meta,
    );

    const parsedPayload = route.parser
      ? route.parser(message.payload)
      : message.payload;
    const response = await route.handler(parsedPayload);
    context.postMessage({
      type: "host_response",
      sourceId: context.participantId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      invokeId: message.invokeId,
      hostId: context.participantId,
      payload: response,
      meta: message.meta,
    });
  } catch (error) {
    context.postMessage({
      type: "host_response",
      sourceId: context.participantId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      invokeId: message.invokeId,
      hostId: context.participantId,
      error: toError(error, "Request failed.").message,
      meta: message.meta,
    });
  }
}

export async function handleHostSignal(
  context: HostContext,
  message: BrowserWindowsHostSignalMessage,
): Promise<void> {
  const route = context.router[message.route];
  if (!route || routeOperation(route) !== "signal") {
    return;
  }

  try {
    await context.assertInboundAllowed(
      message.route,
      "signal",
      message.payload,
      message.meta,
    );

    const parsedPayload = route.parser
      ? route.parser(message.payload)
      : message.payload;
    await route.handler(parsedPayload);
  } catch {
    // signal has no response path
  }
}

export async function handleHostFeedStart(
  context: HostContext,
  message: BrowserWindowsHostFeedStartMessage,
): Promise<void> {
  const route = context.router[message.route];
  if (!route) {
    context.postMessage({
      type: "host_feed_chunk",
      sourceId: context.participantId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      invokeId: message.invokeId,
      hostId: context.participantId,
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      chunkType: "error",
      message: `No feed handler registered for ${message.route}`,
      meta: message.meta,
    });
    return;
  }

  if (routeOperation(route) !== "feed") {
    context.postMessage({
      type: "host_feed_chunk",
      sourceId: context.participantId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      invokeId: message.invokeId,
      hostId: context.participantId,
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      chunkType: "error",
      message: `Route ${message.route} does not support feed operation`,
      meta: message.meta,
    });
    return;
  }

  try {
    await context.assertInboundAllowed(
      message.route,
      "feed",
      message.payload,
      message.meta,
    );

    const parsedPayload = route.parser
      ? route.parser(message.payload)
      : message.payload;
    const produced = route.handler(parsedPayload);
    const asyncIterable = toAsyncIterable(produced);
    const hostedState: HostedFeedState = { stopped: false };

    if (
      typeof produced === "object" &&
      produced !== null &&
      "unsubscribe" in produced &&
      typeof (produced as { unsubscribe?: () => void }).unsubscribe ===
        "function"
    ) {
      hostedState.unsubscribe = () => {
        (produced as { unsubscribe: () => void }).unsubscribe();
      };
    }

    context.hostedFeeds.set(message.requestId, hostedState);

    context.postMessage({
      type: "host_feed_started",
      sourceId: context.participantId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      invokeId: message.invokeId,
      hostId: context.participantId,
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      meta: message.meta,
    });

    for await (const chunk of asyncIterable) {
      if (hostedState.stopped) {
        break;
      }

      context.postMessage({
        type: "host_feed_chunk",
        sourceId: context.participantId,
        sentAtMs: Date.now(),
        requestId: message.requestId,
        invokeId: message.invokeId,
        hostId: context.participantId,
        payloadKey: message.payloadKey,
        payloadHash: message.payloadHash,
        chunkType: "next",
        payload: chunk,
        meta: message.meta,
      });
    }

    context.postMessage({
      type: "host_feed_chunk",
      sourceId: context.participantId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      invokeId: message.invokeId,
      hostId: context.participantId,
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      chunkType: "done",
      meta: message.meta,
    });
  } catch (error) {
    context.postMessage({
      type: "host_feed_chunk",
      sourceId: context.participantId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      invokeId: message.invokeId,
      hostId: context.participantId,
      payloadKey: message.payloadKey,
      payloadHash: message.payloadHash,
      chunkType: "error",
      message: toError(error, "Feed failed.").message,
      meta: message.meta,
    });
  } finally {
    context.hostedFeeds.delete(message.requestId);
  }
}

export async function handleHostFeedStop(
  context: HostContext,
  message: BrowserWindowsHostFeedStopMessage,
): Promise<void> {
  const hosted = context.hostedFeeds.get(message.requestId);
  if (!hosted) {
    return;
  }

  try {
    await context.assertInboundAllowed(
      message.route,
      "signal",
      { payloadKey: message.payloadKey, payloadHash: message.payloadHash },
      message.meta,
    );
  } catch {
    return;
  }

  hosted.stopped = true;
  hosted.unsubscribe?.();
  context.hostedFeeds.delete(message.requestId);
}
