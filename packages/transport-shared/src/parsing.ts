export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; raw: string };

export function safeJsonParse(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      raw: text.length > 200 ? text.slice(0, 200) + "…" : text,
    };
  }
}
