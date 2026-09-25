// An error whose message is safe to show the caller. Anything else is
// reported generically so internal details (and request data) never leak.
export class AiRouteError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
