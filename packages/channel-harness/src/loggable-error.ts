/** JSON-safe shape for errors passed through logger exporters. */
export interface LoggableError {
  name: string;
  message: string;
  stack?: string;
  cause?: LoggableError;
}

/** Preserve useful Error fields without relying on non-enumerable properties. */
export function toLoggableError(error: unknown): LoggableError {
  return normalizeError(error, new Set<Error>());
}

function normalizeError(error: unknown, seen: Set<Error>): LoggableError {
  if (!(error instanceof Error)) {
    return { name: 'NonErrorThrown', message: formatUnknown(error) };
  }

  if (seen.has(error)) {
    return { name: error.name, message: `${error.message} (circular cause)` };
  }

  seen.add(error);
  const result: LoggableError = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  if (error.cause !== undefined) result.cause = normalizeError(error.cause, seen);
  return result;
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
