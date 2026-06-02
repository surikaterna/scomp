// Parent page: listens for log messages from iframes
const logEl = document.getElementById("log");

function addLog(source: string, kind: string, message: string): void {
  if (!logEl) return;
  const entry = document.createElement("div");
  entry.className = "log-entry";
  const time = new Date().toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 });
  entry.innerHTML = `<span class="timestamp">${time}</span> <span class="label-${kind}">[${source}]</span> ${message}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.type === "demo-log") {
    addLog(event.data.source, event.data.kind, event.data.message);
  }
});

addLog("parent", "request", "Cross-window demo loaded. Host and client frames initializing...");
