import { createScompClient } from "@scompr/client";
import { createBrowserWindowsTransport } from "@scompr/transport-browser-windows";

interface DemoMethods {
  double(n: number): Promise<number>;
  alert(payload: { msg: string }): void;
  prices(params: Record<string, never>): AsyncIterable<{ symbol: string; price: number; ts: number }>;
}

interface DemoApi {
  demo: DemoMethods;
}

function postLog(kind: string, message: string): void {
  window.parent.postMessage({ type: "demo-log", source: "client", kind, message }, "*");
  const el = document.getElementById("frame-log");
  if (el) el.textContent += `${message}\n`;
}

const statusEl = document.getElementById("status");
let feedRunning = false;
let feedIterator: AsyncIterator<{ symbol: string; price: number; ts: number }> | null = null;

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

    // Small delay to let host register first
    await new Promise((r) => setTimeout(r, 300));

    const client = createScompClient<DemoApi>({
      transport,
      routeHints: {
        "demo.double": "request",
        "demo.alert": "signal",
        "demo.prices": "feed",
      },
    });

    if (statusEl) statusEl.textContent = "Client ready";
    postLog("request", "Client initialized");

    // Wire buttons
    document.getElementById("btn-request")?.addEventListener("click", async () => {
      postLog("request", "→ demo.double(21)");
      try {
        const result = await client.demo.double(21);
        postLog("request", `← ${result}`);
      } catch (err) {
        postLog("error", `Error: ${err}`);
      }
    });

    document.getElementById("btn-signal")?.addEventListener("click", async () => {
      postLog("signal", '→ demo.alert({ msg: "hello" })');
      try {
        await client.demo.alert({ msg: "hello" });
        postLog("signal", "← (sent)");
      } catch (err) {
        postLog("error", `Error: ${err}`);
      }
    });

    document.getElementById("btn-feed-start")?.addEventListener("click", async () => {
      if (feedRunning) return;
      feedRunning = true;
      const btnStart = document.getElementById("btn-feed-start") as HTMLButtonElement;
      const btnStop = document.getElementById("btn-feed-stop") as HTMLButtonElement;
      btnStart.disabled = true;
      btnStop.disabled = false;

      postLog("feed", "→ demo.prices [subscribing]");
      try {
        const feed = client.demo.prices({} as Record<string, never>);
        const iterator = feed[Symbol.asyncIterator]();
        feedIterator = iterator;

        while (feedRunning) {
          const { done, value } = await iterator.next();
          if (done) break;
          postLog("feed", `← $${value.price.toFixed(2)} @ ${new Date(value.ts).toLocaleTimeString()}`);
        }
      } catch (err) {
        postLog("error", `Feed error: ${err}`);
      }

      postLog("feed", "← [stream ended]");
      btnStart.disabled = false;
      btnStop.disabled = true;
      feedRunning = false;
    });

    document.getElementById("btn-feed-stop")?.addEventListener("click", () => {
      feedRunning = false;
      if (feedIterator?.return) {
        feedIterator.return(undefined);
      }
      feedIterator = null;
    });
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err}`;
    postLog("error", `Init failed: ${err}`);
  }
}

init();
