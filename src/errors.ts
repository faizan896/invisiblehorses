export class AppError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 415 | 503, message: string) { super(message); }
}
