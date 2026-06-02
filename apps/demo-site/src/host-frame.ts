import { createContractToken, createScompPeer, createScompService } from "@scompr/core";
import { createClientFactory } from "@scompr/client";
import { createBrowserWindowsTransport } from "@scompr/transport-browser-windows";

// Contract shared between host and client
interface DemoContract {
  double(n: number): Promise<number>;
  alert(payload: { msg: string }): void;
  prices(params: Record<string, never>): AsyncIterable<{ symbol: string; price: number; ts: number }>;
}

const DemoService = createContractToken<DemoContract>("demo");

function postLog(kind: string, message: string): void {
  window.parent.postMessage({ type: "demo-log", source: "host", kind, message }, "*");
  const el = document.getElementById("frame-log");
  if (el) el.textContent += `${message}\n`;
}

const statusEl = document.getElementById("status");

async function init() {
  try {
    const transport = createBrowserWindowsTransport({
      mode: "broadcast-channel",
      channelName: "scompr-demo",
      routeIntents: {
        "demo.double": "request",
        "demo.alert": "signal",
        "demo.prices": "feed",
      },
    });

    const service = createScompService(DemoService).implement({
      requests: {
        double(n: number) {
          postLog("request", `double(${n}) → ${n * 2}`);
          return Promise.resolve(n * 2);
        },
      },
      signals: {
        alert(payload: { msg: string }) {
          postLog("signal", `alert received: "${payload.msg}"`);
        },
      },
      feeds: {
        prices(_params: Record<string, never>) {
          let running = true;
          let tick = 0;
          postLog("feed", "prices feed started");
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  if (!running) return { done: true as const, value: undefined };
                  await new Promise((r) => setTimeout(r, 500));
                  if (!running) return { done: true as const, value: undefined };
                  tick++;
                  const value = { symbol: "BTC", price: 50000 + Math.random() * 1000, ts: Date.now() };
                  postLog("feed", `tick #${tick}: $${value.price.toFixed(2)}`);
                  return { done: false, value };
                },
                async return() {
                  running = false;
                  postLog("feed", "prices feed stopped");
                  return { done: true as const, value: undefined };
                },
              };
            },
          };
        },
      },
    });

    transport.registerRoutes(service.router);

    // Use createScompPeer for automatic route kind extraction (no routeHints needed)
    const peer = createScompPeer({
      transports: [transport],
      clientFactory: createClientFactory(),
      controlPlane: false,
    });
    peer.provides(service);

    if (statusEl) statusEl.textContent = "Host ready — routes registered";
    postLog("request", "Host initialized, routes registered");
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err}`;
    postLog("error", `Init failed: ${err}`);
  }
}

init();
