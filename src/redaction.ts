import { DEFAULT_SENSITIVE_KEYS, isSensitiveKey as privacySensitiveKey } from "./privacy-keys.js";
import { sanitizeTelemetry } from "./privacy-telemetry.js";

const DEFAULT_REDACT_FIELDS = [
  ...DEFAULT_SENSITIVE_KEYS
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
  try {
    const normalized = normalizeOptions(options);
    const visited = new WeakSet<object>();
    const prepared = sanitize(value, normalized, 0, visited, undefined);
    const protectedValue = sanitizeTelemetry(prepared, { additionalKeys: options.redactFields ?? [] });
    return protectedValue.ok ? protectedValue.value : "[REDACTED]";
  } catch {
    return "[REDACTED]";
  }
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
    redactFields: [...DEFAULT_REDACT_FIELDS, ...(options.redactFields ?? [])],
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
    return "[REDACTED]";
  }
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "string") {
    return truncate(value, options.maxStringLength, options.redactFields);
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
    name: truncate(error.name || "Error", options.maxStringLength, options.redactFields),
    message: truncate(error.message || "", options.maxStringLength, options.redactFields),
    stack: typeof error.stack === "string" ? truncate(error.stack, options.maxStringLength * 4, options.redactFields) : null,
    cause: "cause" in error ? sanitize(error.cause, options, depth + 1, visited, "cause") : null
  };
}

function truncate(value: string, maxLength: number, fields: string[]): string {
  if (value.length > 16 * 1024) return "[REDACTED]";
  const safe = sanitizeTelemetry(value, { additionalKeys: fields });
  if (!safe.ok || typeof safe.value !== "string") return "[REDACTED]";
  if (safe.value.length <= maxLength) return safe.value;
  return `${safe.value.slice(0, maxLength)}...[Truncated]`;
}

function isSensitiveKey(key: string, sensitiveFields: string[]): boolean {
  return privacySensitiveKey(key, [...DEFAULT_SENSITIVE_KEYS, ...sensitiveFields]);
}
