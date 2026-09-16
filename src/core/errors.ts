export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
    public readonly retryable = false,
    public readonly hint?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function asError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error && error.name === "TimeoutError") {
    return new AppError("TIMEOUT", "The operation timed out.", 124, true);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new AppError("CANCELLED", "The operation was cancelled.", 130);
  }
  return new AppError("INTERNAL_ERROR", "An unexpected error occurred.");
}

export function errorData(error: AppError) {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.hint ? { hint: error.hint } : {}),
    ...(error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
  };
}

export function usage(message: string): never {
  throw new AppError("INVALID_USAGE", message, 2);
}
