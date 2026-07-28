import type { DebugBundleBeforeSend, DebugBundleEventEnvelope } from "./types.js";

const ROOT_KEYS = new Set([
  "schema_version",
  "event_id",
  "event_type",
  "sdk_name",
  "sdk_version",
  "service",
  "occurred_at",
  "correlation",
  "context",
  "payload"
]);

const REQUIRED_PAYLOAD_FIELDS: Record<DebugBundleEventEnvelope["event_type"], string[]> = {
  frontend_exception: ["name", "message", "stack"],
  frontend_breadcrumb: ["breadcrumb_type", "data"],
  log_event: ["level", "message", "attributes"],
  request_event: ["method", "path", "query", "headers", "response_status", "duration_ms"],
  error_suppressed: ["fingerprint", "suppressed_count", "window_seconds", "first_seen", "last_seen"],
  probe_event: ["label", "data", "activation_id", "probe_label_pattern"]
};
const ALLOWED_PAYLOAD_FIELDS: Record<DebugBundleEventEnvelope["event_type"], Set<string>> = {
  frontend_exception: new Set([
    "name", "message", "stack", "route", "browser", "breadcrumbs", "device",
    "browser_event", "rejection_reason", "dom_context", "probe_data"
  ]),
  frontend_breadcrumb: new Set(["breadcrumb_type", "route", "data", "device"]),
  log_event: new Set(["level", "message", "attributes", "device"]),
  request_event: new Set([
    "method", "path", "query", "headers", "body", "response_status", "duration_ms",
    "route_template", "response_headers", "response_body", "device"
  ]),
  error_suppressed: new Set([
    "fingerprint", "suppressed_count", "window_seconds", "first_seen", "last_seen", "device"
  ]),
  probe_event: new Set(["label", "data", "activation_id", "probe_label_pattern", "device"])
};

const EVENT_TYPES = new Set(Object.keys(REQUIRED_PAYLOAD_FIELDS));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function applyBeforeSend(
  event: DebugBundleEventEnvelope,
  hook: DebugBundleBeforeSend | null
): DebugBundleEventEnvelope | null {
  if (!hook) {
    return event;
  }
  try {
    const result = hook(cloneEvent(event));
    if (result === null) {
      return null;
    }
    return isValidEvent(result) ? result : event;
  } catch {
    return event;
  }
}

function cloneEvent(event: DebugBundleEventEnvelope): DebugBundleEventEnvelope {
  return JSON.parse(JSON.stringify(event)) as DebugBundleEventEnvelope;
}

function isValidEvent(event: unknown): event is DebugBundleEventEnvelope {
  if (!isRecord(event) || !Object.keys(event).every((key) => ROOT_KEYS.has(key))) {
    return false;
  }
  if (
    event.schema_version !== "2026-03-01" ||
    !UUID_PATTERN.test(stringValue(event.event_id)) ||
    !EVENT_TYPES.has(stringValue(event.event_type)) ||
    event.sdk_name !== "@debugbundle/sdk-react-native" ||
    !nonEmptyString(event.sdk_version) ||
    !isIsoTimestamp(event.occurred_at) ||
    !isRecord(event.service) ||
    !nonEmptyString(event.service.name) ||
    !nonEmptyString(event.service.environment) ||
    event.service.runtime !== "react-native" ||
    event.service.framework !== "react-native" ||
    !isRecord(event.payload)
  ) {
    return false;
  }
  const eventType = event.event_type as DebugBundleEventEnvelope["event_type"];
  return (
    REQUIRED_PAYLOAD_FIELDS[eventType].every((field) =>
      Object.prototype.hasOwnProperty.call(event.payload, field)
    ) &&
    Object.keys(event.payload).every((field) => ALLOWED_PAYLOAD_FIELDS[eventType].has(field)) &&
    hasValidPayloadShape(eventType, event.payload)
  );
}

function hasValidPayloadShape(
  eventType: DebugBundleEventEnvelope["event_type"],
  payload: Record<string, unknown>
): boolean {
  switch (eventType) {
    case "frontend_exception":
      return (
        hasNonEmptyStrings(payload, "name", "message", "stack") &&
        (!("breadcrumbs" in payload) || Array.isArray(payload.breadcrumbs)) &&
        optionalRecord(payload, "probe_data")
      );
    case "frontend_breadcrumb":
      return hasNonEmptyStrings(payload, "breadcrumb_type") && isRecord(payload.data);
    case "log_event":
      return hasNonEmptyStrings(payload, "level", "message") && isRecord(payload.attributes);
    case "request_event":
      return (
        hasNonEmptyStrings(payload, "method", "path") &&
        isRecord(payload.query) &&
        isRecord(payload.headers) &&
        isNonNegativeNumber(payload.response_status) &&
        isNonNegativeNumber(payload.duration_ms) &&
        optionalRecord(payload, "response_headers")
      );
    case "error_suppressed":
      return (
        hasNonEmptyStrings(payload, "fingerprint") &&
        isNonNegativeInteger(payload.suppressed_count) &&
        isPositiveInteger(payload.window_seconds) &&
        isIsoTimestamp(payload.first_seen) &&
        isIsoTimestamp(payload.last_seen)
      );
    case "probe_event":
      return (
        hasNonEmptyStrings(payload, "label", "probe_label_pattern") &&
        isRecord(payload.data) &&
        (payload.activation_id === null ||
          nonEmptyString(payload.activation_id) && UUID_PATTERN.test(payload.activation_id))
      );
  }
}

function hasNonEmptyStrings(payload: Record<string, unknown>, ...fields: string[]): boolean {
  return fields.every((field) => nonEmptyString(payload[field]));
}

function optionalRecord(payload: Record<string, unknown>, field: string): boolean {
  return !(field in payload) || isRecord(payload[field]);
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isIsoTimestamp(value: unknown): boolean {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}
