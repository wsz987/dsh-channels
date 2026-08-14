/**
 * Security helpers for the dsh-channels host API (M1). Pure, unit-testable.
 *
 * Rules (spec §2.2):
 *  - state-changing requests (POST) are loopback-only;
 *  - POST bodies must be application/json (else 415);
 *  - bodies are capped at BODY_LIMIT_BYTES (else 413);
 *  - error messages are sanitized so no token/secret leaks into a response.
 */

/** Upper bound for a request body payload (64 KiB). */
export const BODY_LIMIT_BYTES = 64 * 1024;

const LOOPBACK = new Set<string>(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * True when the socket remote address is a loopback address.
 * Used to restrict state-changing API calls to the local machine.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return LOOPBACK.has(address);
}

/** True when the Content-Type header is application/json (options ignored). */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const [media] = contentType.split(';').map((s) => s.trim());
  return media?.toLowerCase() === 'application/json';
}

/** Structured result of reading + parsing a JSON request body. */
export type BodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 413 | 415 | 400; error: PublicErrorBody };

export interface PublicErrorBody {
  error: { code: string; message: string };
}

export function errorBody(code: string, message: string): PublicErrorBody {
  return { error: { code, message: sanitizeError(message) } };
}

/**
 * Read a JSON request body from a node:http IncomingMessage, respecting the
 * 64 KiB cap. Never trusts caller-provided Content-Length; it reads the real
 * stream to enforce the byte limit regardless of the header.
 */
export async function readJsonBody<T>(req: AsyncIterable<Buffer | string>): Promise<BodyResult<T>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > BODY_LIMIT_BYTES) {
      return { ok: false, status: 413, error: errorBody('BODY_TOO_LARGE', 'request body exceeds 64 KiB limit') };
    }
    chunks.push(buf);
  }

  // An empty body is treated as an empty object; endpoints validate their
  // own required fields (e.g. challengeId), so auth/start (no body) works.
  if (total === 0) {
    return { ok: true, value: {} as T };
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, status: 400, error: errorBody('INVALID_JSON', 'request body is not valid JSON') };
  }
}

/** Regex capturing common credential-shaped fragments in an error message. */
const SECRET_PATTERNS: RegExp[] = [
  /(\b(?:token|aeskey|secret|password|verifycode|verify_code|verify code)\b\s*[:=]\s*)\S+/gi,
  /\b(?:Illegal character code range [0-9a-f-]+)/gi,
];

/**
 * Best-effort sanitization of an error message so no secret/credential
 * leaks into an API response. Values like 'token=...' / 'aeskey=...' are
 * replaced with a redaction marker.
 */
export function sanitizeError(message: string): string {
  let out = String(message ?? '');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix?: string) => (prefix ?? '') + '<redacted>');
  }
  return out.length > 500 ? out.slice(0, 500) + '…' : out;
}