export function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return fallback;
}

export function toUnavailableDetail(reasonCode: string, detail: string): string {
  return `${reasonCode}: ${detail}`;
}
