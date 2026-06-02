import type { ScompHandlerContext } from "@scompr/core";
import type { ScompTransportMessageMeta } from "@scompr/types";
import type {
  BrowserWindowsHostFeedStartMessage,
  BrowserWindowsHostFeedStopMessage,
  BrowserWindowsHostRequestMessage,
  BrowserWindowsHostSignalMessage,
} from "./protocol";
import { toAsyncIterable, toError } from "./transport-browser-windows-runtime";
import type { HostedFeedState, RuntimeRoute } from "./transport-browser-windows-state";
import { routeOperation } from "./transport-browser-windows-state";

interface HostContext {
  readonly participantId: string;
  readonly router: Record<string, RuntimeRoute>;
  readonly hostedFeeds: Map<string, HostedFeedState>;
  postMessage(message: unknown): void;
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

  const kind = routeOperation(route);

  if (kind === "signal") {
    await handleHostRequestAsSignal(context, route, message);
    return;
  }

  if (kind === "feed") {
    await handleHostRequestAsFeed(context, route, message);
    return;
  }

  await handleHostRequestAsRequest(context, route, message);
}

async function handleHostRequestAsRequest(
  context: HostContext,
  route: RuntimeRoute,
  message: BrowserWindowsHostRequestMessage,
): Promise<void> {
  try {
    const parsedPayload = route.parser ? route.parser(message.payload) : message.payload;
    const handlerCtx: ScompHandlerContext = {
      route: message.route,
      operation: "request",
      meta: message.meta as ScompTransportMessageMeta | undefined,
    };
    const response = await route.handler(parsedPayload, handlerCtx);
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
    const errorCode = (error as Record<string, unknown>)?.code;
    context.postMessage({
      type: "host_response",
      sourceId: context.participantId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      invokeId: message.invokeId,
      hostId: context.participantId,
      error: toError(error, "Request failed.").message,
      code: errorCode === "UNAUTHORIZED" ? "UNAUTHORIZED" : undefined,
      meta: message.meta,
    });
  }
}

async function handleHostRequestAsSignal(
  context: HostContext,
  route: RuntimeRoute,
  message: BrowserWindowsHostRequestMessage,
): Promise<void> {
  try {
    const parsedPayload = route.parser ? route.parser(message.payload) : message.payload;
    const handlerCtx: ScompHandlerContext = {
      route: message.route,
      operation: "signal",
      meta: message.meta as ScompTransportMessageMeta | undefined,
    };
    await route.handler(parsedPayload, handlerCtx);
  } catch {
    // signal errors are not propagated
  }
  context.postMessage({
    type: "host_response",
    sourceId: context.participantId,
    sentAtMs: Date.now(),
    requestId: message.requestId,
    invokeId: message.invokeId,
    hostId: context.participantId,
    payload: undefined,
    meta: message.meta,
  });
}

async function handleHostRequestAsFeed(
  context: HostContext,
  route: RuntimeRoute,
  message: BrowserWindowsHostRequestMessage,
): Promise<void> {
  try {
    const parsedPayload = route.parser ? route.parser(message.payload) : message.payload;
    const handlerCtx: ScompHandlerContext = {
      route: message.route,
      operation: "feed",
      meta: message.meta as ScompTransportMessageMeta | undefined,
    };
    const produced = route.handler(parsedPayload, handlerCtx);
    const asyncIterable = toAsyncIterable(produced);
    const hostedState: HostedFeedState = { stopped: false };

    if (
      typeof produced === "object" &&
      produced !== null &&
      "unsubscribe" in produced &&
      typeof (produced as { unsubscribe?: () => void }).unsubscribe === "function"
    ) {
      hostedState.unsubscribe = () => {
        (produced as { unsubscribe: () => void }).unsubscribe();
      };
    }

    context.hostedFeeds.set(message.requestId, hostedState);

    // Send feed marker response so the client knows to expect chunks
    context.postMessage({
      type: "host_response",
      sourceId: context.participantId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      invokeId: message.invokeId,
      hostId: context.participantId,
      payload: { __scomp_feed: true },
      meta: message.meta,
    });

    for await (const chunk of asyncIterable) {
      if (hostedState.stopped) break;

      context.postMessage({
        type: "invoke_feed_chunk",
        sourceId: context.participantId,
        targetId: message.invokeId,
        sentAtMs: Date.now(),
        requestId: message.requestId,
        hostId: context.participantId,
        payloadKey: "",
        payloadHash: "",
        chunkType: "next",
        payload: chunk,
        meta: message.meta,
      });
    }

    context.postMessage({
      type: "invoke_feed_chunk",
      sourceId: context.participantId,
      targetId: message.invokeId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      hostId: context.participantId,
      payloadKey: "",
      payloadHash: "",
      chunkType: "done",
      meta: message.meta,
    });
  } catch (error) {
    context.postMessage({
      type: "invoke_feed_chunk",
      sourceId: context.participantId,
      targetId: message.invokeId,
      sentAtMs: Date.now(),
      requestId: message.requestId,
      hostId: context.participantId,
      payloadKey: "",
      payloadHash: "",
      chunkType: "error",
      message: toError(error, "Feed failed.").message,
      meta: message.meta,
    });
  } finally {
    context.hostedFeeds.delete(message.requestId);
  }
}

export async function handleHostSignal(context: HostContext, message: BrowserWindowsHostSignalMessage): Promise<void> {
  const route = context.router[message.route];
  if (!route || routeOperation(route) !== "signal") {
    return;
  }

  try {
    const parsedPayload = route.parser ? route.parser(message.payload) : message.payload;
    const handlerCtx: ScompHandlerContext = {
      route: message.route,
      operation: "signal",
      meta: message.meta as ScompTransportMessageMeta | undefined,
    };
    await route.handler(parsedPayload, handlerCtx);
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
    const parsedPayload = route.parser ? route.parser(message.payload) : message.payload;
    const handlerCtx: ScompHandlerContext = {
      route: message.route,
      operation: "feed",
      meta: message.meta as ScompTransportMessageMeta | undefined,
    };
    const produced = route.handler(parsedPayload, handlerCtx);
    const asyncIterable = toAsyncIterable(produced);
    const hostedState: HostedFeedState = { stopped: false };

    if (
      typeof produced === "object" &&
      produced !== null &&
      "unsubscribe" in produced &&
      typeof (produced as { unsubscribe?: () => void }).unsubscribe === "function"
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

  hosted.stopped = true;
  hosted.unsubscribe?.();
  context.hostedFeeds.delete(message.requestId);
}
