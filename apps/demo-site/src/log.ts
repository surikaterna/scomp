const logEl = document.getElementById("log");

export function log(label: string, kind: "request" | "signal" | "feed" | "error", message: string): void {
  if (!logEl) return;
  const entry = document.createElement("div");
  entry.className = "log-entry";
  const time = new Date().toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 });
  entry.innerHTML = `<span class="timestamp">${time}</span> <span class="label-${kind}">[${label}]</span> ${escapeHtml(message)}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
