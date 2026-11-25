import { sanitizeTelemetry } from "./privacy-telemetry.js";
import type { DebugBundleEventEnvelope } from "./types.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuidV4 = (value: string): boolean => UUID_V4.test(value);

const VALID_EVIDENCE_RUNTIMES = new Set(["browser", "node", "python", "php", "ruby", "java", "go", "dotnet", "rust", "android", "swift", "react_native"]);
const VALID_TRACE_ORIGINS = new Set(["throw", "native_fatal", "capture", "runtime_reported", "unavailable", "unknown"]);
const VALID_PARSING_STATUSES = new Set(["parsed", "partial", "unparsed", "unavailable", "truncated"]);
const VALID_FRAME_CLASSIFICATIONS = new Set(["app", "framework", "sdk", "runtime", "unknown"]);
const VALID_UNAVAILABLE_REASONS = new Set(["unknown", "unsupported", "unsafe", "budget_exceeded"]);
const VALID_RECOVERY_STATES = new Set(["attempt_started", "attempt_completed", "attempt_failed", "recovery_observed", "failure_persisted"]);
const VALID_EVIDENCE_LIMIT_KEYS = new Set(["exception_evidence", "recovery", "resource_observations", "execution"]);

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSafeString(value: unknown, additionalKeys: readonly string[], exactKeys: readonly string[]): value is string {
  if (typeof value !== "string") return false;
  const checked = sanitizeTelemetry(value, { additionalKeys, exactKeys });
  return checked.ok && checked.value === value;
}

function scrubString(value: unknown, additionalKeys: readonly string[], exactKeys: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  const checked = sanitizeTelemetry(value, { additionalKeys, exactKeys });
  return checked.ok && typeof checked.value === "string" ? checked.value : "[REDACTED]";
}

function sanitizeEvidenceScope(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  const kind = ownValue(value, "kind");
  if (kind === "page" && keys.length === 2) {
    const pageId = ownValue(value, "page_id");
    if (typeof pageId === "string" && isUuidV4(pageId)) return { kind: "page", page_id: pageId };
  }
  if (kind === "operation" && keys.length === 2) {
    const operationId = ownValue(value, "operation_id");
    if (typeof operationId === "string" && isUuidV4(operationId)) return { kind: "operation", operation_id: operationId };
  }
  return null;
}

function sanitizeEvidenceReference(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value) || Object.keys(value).length !== 3) return null;
  const version = ownValue(value, "version");
  const failureRef = ownValue(value, "failure_ref");
  const scope = sanitizeEvidenceScope(ownValue(value, "scope"));
  if (version !== 1 || typeof failureRef !== "string" || !isUuidV4(failureRef) || scope === null) return null;
  return { version: 1, failure_ref: failureRef, scope };
}

function sanitizeEvidenceLimits(value: unknown): Record<string, string> | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > 4) return null;
  const output: Record<string, string> = {};
  for (const key of keys) {
    const entry = ownValue(value, key);
    if (!VALID_EVIDENCE_LIMIT_KEYS.has(key) || typeof entry !== "string" || !VALID_UNAVAILABLE_REASONS.has(entry)) {
      return null;
    }
    output[key] = entry;
  }
  return output;
}

function sanitizeExceptionEvidence(
  value: unknown,
  additionalKeys: readonly string[],
  exactKeys: readonly string[]
): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  const version = ownValue(value, "version");
  const runtime = ownValue(value, "runtime");
  const rootId = ownValue(value, "root_id");
  const truncated = ownValue(value, "truncated");
  const unavailableReason = ownValue(value, "unavailable_reason");
  const rawNodes = ownValue(value, "nodes");
  if (
    version !== 1 ||
    typeof runtime !== "string" ||
    !VALID_EVIDENCE_RUNTIMES.has(runtime) ||
    typeof rootId !== "number" ||
    !Number.isInteger(rootId) ||
    rootId < 0 ||
    typeof truncated !== "boolean" ||
    (unavailableReason !== null && (typeof unavailableReason !== "string" || !VALID_UNAVAILABLE_REASONS.has(unavailableReason))) ||
    !Array.isArray(rawNodes) ||
    rawNodes.length === 0 ||
    rawNodes.length > 8
  ) {
    return null;
  }
  const nodes: Record<string, unknown>[] = [];
  for (const rawNode of rawNodes) {
    if (!isPlainRecord(rawNode)) return null;
    const id = ownValue(rawNode, "id");
    const name = scrubString(ownValue(rawNode, "name"), additionalKeys, exactKeys);
    const message = scrubString(ownValue(rawNode, "message"), additionalKeys, exactKeys);
    const rawStack = ownValue(rawNode, "stack");
    const stack = rawStack === null ? null : scrubString(rawStack, additionalKeys, exactKeys);
    const traceOrigin = ownValue(rawNode, "trace_origin");
    const parsingStatus = ownValue(rawNode, "parsing_status");
    const rawFrames = ownValue(rawNode, "frames");
    const rawRels = ownValue(rawNode, "relationships");
    if (
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      id < 0 ||
      name === null ||
      message === null ||
      (rawStack !== null && stack === null) ||
      typeof traceOrigin !== "string" ||
      !VALID_TRACE_ORIGINS.has(traceOrigin) ||
      typeof parsingStatus !== "string" ||
      !VALID_PARSING_STATUSES.has(parsingStatus) ||
      !Array.isArray(rawFrames) ||
      rawFrames.length > 64 ||
      !Array.isArray(rawRels) ||
      rawRels.length > 16
    ) {
      return null;
    }
    const frames: Record<string, unknown>[] = [];
    for (const rawFrame of rawFrames) {
      if (!isPlainRecord(rawFrame)) return null;
      const rawFn = ownValue(rawFrame, "function");
      const rawFile = ownValue(rawFrame, "file");
      const line = ownValue(rawFrame, "line");
      const column = ownValue(rawFrame, "column");
      const classification = ownValue(rawFrame, "classification");
      if (
        (rawFn !== null && typeof rawFn !== "string") ||
        (rawFile !== null && typeof rawFile !== "string") ||
        (line !== null && (typeof line !== "number" || !Number.isInteger(line) || line < 0)) ||
        (column !== null && (typeof column !== "number" || !Number.isInteger(column) || column < 0)) ||
        typeof classification !== "string" ||
        !VALID_FRAME_CLASSIFICATIONS.has(classification)
      ) {
        return null;
      }
      frames.push({
        function: rawFn === null ? null : scrubString(rawFn, additionalKeys, exactKeys),
        file: rawFile === null ? null : scrubString(rawFile, additionalKeys, exactKeys),
        line,
        column,
        classification
      });
    }
    const relationships: Record<string, unknown>[] = [];
    for (const rel of rawRels) {
      if (!isPlainRecord(rel)) return null;
      const kind = ownValue(rel, "kind");
      const targetId = ownValue(rel, "target_id");
      if (
        (kind !== "cause" && kind !== "suppressed" && kind !== "aggregate") ||
        typeof targetId !== "number" ||
        !Number.isInteger(targetId) ||
        targetId < 0
      ) {
        return null;
      }
      relationships.push({ kind, target_id: targetId });
    }
    nodes.push({
      id,
      name,
      message,
      stack,
      trace_origin: traceOrigin,
      parsing_status: parsingStatus,
      frames,
      relationships
    });
  }
  return {
    version: 1,
    runtime,
    root_id: rootId,
    nodes,
    truncated,
    unavailable_reason: unavailableReason
  };
}

function sanitizeDiagnosticContextPayload(
  payload: Record<string, unknown>,
  additionalKeys: readonly string[],
  exactKeys: readonly string[]
): Record<string, unknown> | null {
  const version = ownValue(payload, "version");
  const kind = ownValue(payload, "kind");
  const failureRef = ownValue(payload, "failure_ref");
  const scope = sanitizeEvidenceScope(ownValue(payload, "scope"));
  if (version !== 1 || kind !== "recovery" || typeof failureRef !== "string" || !isUuidV4(failureRef) || scope === null) {
    return null;
  }
  const attemptId = ownValue(payload, "attempt_id");
  const state = ownValue(payload, "state");
  if (typeof attemptId !== "string" || !isUuidV4(attemptId) || typeof state !== "string" || !VALID_RECOVERY_STATES.has(state)) {
    return null;
  }
  const output: Record<string, unknown> = {
    version: 1,
    kind: "recovery",
    failure_ref: failureRef,
    scope,
    attempt_id: attemptId,
    state
  };
  const operation = ownValue(payload, "operation");
  if (operation !== undefined) {
    const safeOp = scrubString(operation, additionalKeys, exactKeys);
    if (safeOp === null) return null;
    output.operation = safeOp;
  }
  const statusCode = ownValue(payload, "status_code");
  if (statusCode !== undefined) {
    if (typeof statusCode !== "number" || !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) return null;
    output.status_code = statusCode;
  }
  const durationMs = ownValue(payload, "duration_ms");
  if (durationMs !== undefined) {
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return null;
    output.duration_ms = durationMs;
  }
  return output;
}

export function protectEventFields(
  event: DebugBundleEventEnvelope,
  additionalKeys: readonly string[],
  exactKeys: readonly string[] = []
): DebugBundleEventEnvelope | null {
  for (const value of [
    event.schema_version,
    event.sdk_name,
    event.sdk_version,
    ...Object.values(event.correlation ?? {})
  ]) {
    if (typeof value !== "string") continue;
    if (!isSafeString(value, additionalKeys, exactKeys)) return null;
  }

  let diagnosticPayload: Record<string, unknown> | null = null;
  const preservedPayload: Record<string, unknown> = {};
  const payloadToSanitize: Record<string, unknown> = isPlainRecord(event.payload) ? { ...event.payload } : {};

  if (event.event_type === "diagnostic_context") {
    diagnosticPayload = isPlainRecord(event.payload)
      ? sanitizeDiagnosticContextPayload(event.payload, additionalKeys, exactKeys)
      : null;
    if (diagnosticPayload === null) return null;
  } else {
    if (
      (event.event_type === "frontend_exception" || event.event_type === "backend_exception") &&
      Object.prototype.hasOwnProperty.call(payloadToSanitize, "exception_evidence")
    ) {
      const safeGraph = sanitizeExceptionEvidence(
        ownValue(payloadToSanitize, "exception_evidence"),
        additionalKeys,
        exactKeys
      );
      if (safeGraph !== null) {
        preservedPayload.exception_evidence = safeGraph;
        delete payloadToSanitize.exception_evidence;
      }
    }
    if (event.event_type === "error_suppressed" && ownValue(payloadToSanitize, "reason") === "queue_pressure") {
      preservedPayload.reason = "queue_pressure";
      delete payloadToSanitize.reason;
    }
  }

  const preservedContext: Record<string, unknown> = {};
  let contextToSanitize: Record<string, unknown> | undefined;
  if (event.context !== undefined) {
    if (!isPlainRecord(event.context)) return null;
    contextToSanitize = { ...event.context };
    if (Object.prototype.hasOwnProperty.call(contextToSanitize, "evidence_reference")) {
      const safeRef = sanitizeEvidenceReference(ownValue(contextToSanitize, "evidence_reference"));
      if (safeRef !== null) {
        preservedContext.evidence_reference = safeRef;
        delete contextToSanitize.evidence_reference;
      }
    }
    if (Object.prototype.hasOwnProperty.call(contextToSanitize, "evidence_limits")) {
      const safeLimits = sanitizeEvidenceLimits(ownValue(contextToSanitize, "evidence_limits"));
      if (safeLimits !== null) {
        preservedContext.evidence_limits = safeLimits;
        delete contextToSanitize.evidence_limits;
      }
    }
  }

  const result = sanitizeTelemetry(
    {
      service: event.service,
      payload: diagnosticPayload === null ? payloadToSanitize : {},
      ...(contextToSanitize !== undefined ? { context: contextToSanitize } : {})
    },
    { additionalKeys, exactKeys }
  );
  if (!result.ok || !isPlainRecord(result.value)) return null;
  const safeFields = result.value;
  if (!isPlainRecord(safeFields.service) || !isPlainRecord(safeFields.payload)) return null;

  const finalPayload =
    diagnosticPayload !== null
      ? diagnosticPayload
      : { ...safeFields.payload, ...preservedPayload };
  const finalContext =
    contextToSanitize !== undefined && isPlainRecord(safeFields.context)
      ? { ...safeFields.context, ...preservedContext }
      : undefined;

  return {
    ...event,
    service: safeFields.service as DebugBundleEventEnvelope["service"],
    payload: finalPayload,
    ...(finalContext !== undefined ? { context: finalContext } : {})
  };
}
