export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status || 500;
    this.details = details || null;
  }
}

export function toErrorPayload(err) {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: err.message, details: err.details } };
  }
  // body-parser and friends attach a status; respect it (413 for oversized
  // payloads, 400 for malformed JSON) instead of reporting a generic 500.
  const status = Number(err && (err.status || err.statusCode));
  if (Number.isFinite(status) && status >= 400 && status <= 599) {
    const hint = err.type === "entity.too.large"
      ? "The upload is too large. Raise the limit or send smaller anchor images."
      : err.message;
    return { status, body: { error: hint || "Request failed", details: null } };
  }
  const message = err && err.message ? err.message : String(err);
  return { status: 500, body: { error: message, details: null } };
}

export function assert(condition, message, status) {
  if (!condition) throw new HttpError(status || 400, message);
}
