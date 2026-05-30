const DEFAULT_REDACT_FIELDS = [
  "password",
  "secret",
  "token",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "private_key",
  "passwd",
  "card_number",
  "cvv",
  "cvc",
  "pin",
  "expiry",
  "phone",
  "bearer",
  "session_id",
  "otp",
  "verification_code",
  "authorization",
  "cookie",
  "ssn"
];

export const DEFAULT_HEADER_ALLOWLIST = [
  "user-agent",
  "content-type",
  "accept",
  "x-request-id",
  "x-correlation-id",
  "x-debugbundle-trace-id",
  "traceparent"
];

export interface SanitizeOptions {
  redactFields?: string[];
  maxDepth?: number;
  maxStringLength?: number;
  maxArrayLength?: number;
  maxObjectKeys?: number;
}

export function defaultRedactFields(): string[] {
  return [...DEFAULT_REDACT_FIELDS];
}

export function sanitizeValue(value: unknown, options: SanitizeOptions = {}): unknown {
  const visited = new WeakSet<object>();
  return sanitize(value, normalizeOptions(options), 0, visited, undefined);
}

export function sanitizeHeaders(
  headers: Record<string, string> | undefined,
  allowlist: string[] = DEFAULT_HEADER_ALLOWLIST,
  options: SanitizeOptions = {}
): Record<string, string> {
  if (!headers) {
    return {};
  }
  const allowed = new Set(allowlist.map((header) => header.toLowerCase()));
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (allowed.has(normalizedKey)) {
      sanitized[normalizedKey] = String(sanitizeValue(value, options));
    }
  }
  return sanitized;
}

function normalizeOptions(options: SanitizeOptions): Required<SanitizeOptions> {
  return {
    redactFields: options.redactFields ?? DEFAULT_REDACT_FIELDS,
    maxDepth: options.maxDepth ?? 8,
    maxStringLength: options.maxStringLength ?? 2048,
    maxArrayLength: options.maxArrayLength ?? 50,
    maxObjectKeys: options.maxObjectKeys ?? 50
  };
}

function sanitize(
  value: unknown,
  options: Required<SanitizeOptions>,
  depth: number,
  visited: WeakSet<object>,
  key: string | undefined
): unknown {
  if (key && isSensitiveKey(key, options.redactFields)) {
    return "[Redacted]";
  }
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "string") {
    return truncate(value, options.maxStringLength);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }
  if (value instanceof Error) {
    return sanitizeError(value, options, depth, visited);
  }
  if (depth >= options.maxDepth) {
    return "[Truncated: depth]";
  }
  if (typeof value === "object") {
    if (visited.has(value)) {
      return "[Circular]";
    }
    visited.add(value);
    if (Array.isArray(value)) {
      return value
        .slice(0, options.maxArrayLength)
        .map((entry) => sanitize(entry, options, depth + 1, visited, undefined));
    }
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value).slice(0, options.maxObjectKeys)) {
      output[entryKey] = sanitize(entryValue, options, depth + 1, visited, entryKey);
    }
    return output;
  }
  return String(value);
}

function sanitizeError(
  error: Error,
  options: Required<SanitizeOptions>,
  depth: number,
  visited: WeakSet<object>
): Record<string, unknown> {
  return {
    name: truncate(error.name || "Error", options.maxStringLength),
    message: truncate(error.message || "", options.maxStringLength),
    stack: typeof error.stack === "string" ? truncate(error.stack, options.maxStringLength * 4) : null,
    cause: "cause" in error ? sanitize(error.cause, options, depth + 1, visited, "cause") : null
  };
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...[Truncated]`;
}

function isSensitiveKey(key: string, sensitiveFields: string[]): boolean {
  const segments = splitKey(key);
  const sensitive = new Set(sensitiveFields.flatMap(splitKey));
  return segments.some((segment) => sensitive.has(segment));
}

function splitKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^a-zA-Z0-9]+/)
    .map((segment) => segment.toLowerCase())
    .filter(Boolean);
}
