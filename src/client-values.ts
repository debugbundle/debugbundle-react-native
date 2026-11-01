import type { NativeDebugBundleState, DebugBundleEventEnvelope, ResolvedDebugBundleConfig } from "./types.js";

export function correlationFromContext(context: Record<string, unknown>, traceId: string | null = null): DebugBundleEventEnvelope["correlation"] {
  const nested = Object.getOwnPropertyDescriptor(context, "correlation");
  const source = nested && "value" in nested && nested.value && typeof nested.value === "object" ? nested.value : {};
  const result: NonNullable<DebugBundleEventEnvelope["correlation"]> = {};
  for (const key of ["request_id", "trace_id", "session_id", "user_id_hash"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key) ?? Object.getOwnPropertyDescriptor(context, key);
    if (descriptor && "value" in descriptor && (descriptor.value === null || typeof descriptor.value === "string")) result[key] = descriptor.value;
  }
  if (traceId !== null) result.trace_id = traceId;
  return Object.keys(result).length ? result : undefined;
}

/** Both inputs are validated, owned canonical device JSON. Key order is immaterial. */
export function sameMobileDevice(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) || Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameMobileDevice(a[key], b[key]));
}

export function normalizeNativeState(state: NativeDebugBundleState): NativeDebugBundleState {
  return {
    ...state,
    status: state.status || "healthy",
    nativeModuleAvailable: state.nativeModuleAvailable ?? true
  };
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function objectWrap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

export function parseRequestUrl(url: string): { path: string; query: Record<string, unknown> } {
  try {
    const parsed = new URL(url);
    const query: Record<string, unknown> = {};
    for (const [key, value] of parsed.searchParams) {
      const existing = query[key];
      if (existing === undefined) {
        query[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[key] = [existing, value];
      }
    }
    return { path: parsed.pathname || "/", query };
  } catch {
    const [path = "/", rawQuery = ""] = url.split("?", 2);
    const query: Record<string, unknown> = {};
    for (const segment of rawQuery.split("&")) {
      if (!segment) {
        continue;
      }
      const [rawKey = "", rawValue = ""] = segment.split("=", 2);
      const key = decodeQuerySegment(rawKey);
      const value = decodeQuerySegment(rawValue);
      const existing = query[key];
      if (existing === undefined) {
        query[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[key] = [existing, value];
      }
    }
    return { path: path || "/", query };
  }
}

function decodeQuerySegment(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

export function sanitizeScreenName(screenName: string): string {
  return screenName.replace(/[^a-zA-Z0-9_.:/-]/g, "_").slice(0, 120);
}

export function generateId(): string {
  const cryptoLike = globalThis.crypto;
  if (cryptoLike?.randomUUID) {
    return cryptoLike.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (marker) => {
    const random = Math.trunc(Math.random() * 16);
    const value = marker === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function canonicalDevice(
  nativeDevice: Record<string, unknown> | null | undefined,
  config: ResolvedDebugBundleConfig
): Record<string, unknown> {
  const source = nativeDevice ?? {};
  const sourceOs = asRecord(source.os);
  const sourceScreen = asRecord(source.screen);
  const sourceViewport = asRecord(source.viewport);
  const width = nonNegativeInteger(sourceScreen.width ?? source.screen_width);
  const height = nonNegativeInteger(sourceScreen.height ?? source.screen_height);
  return {
    user_agent: stringValue(source.user_agent),
    os: {
      name: stringValue(sourceOs.name ?? source.os_name),
      version: stringValue(sourceOs.version ?? source.os_version)
    },
    device_type: canonicalDeviceType(source.device_type),
    screen: { width, height },
    viewport: {
      width: nonNegativeInteger(sourceViewport.width ?? width),
      height: nonNegativeInteger(sourceViewport.height ?? height)
    },
    device_pixel_ratio: positiveNumber(source.device_pixel_ratio),
    touch_capable: typeof source.touch_capable === "boolean" ? source.touch_capable : null,
    language: stringValue(source.language ?? source.locale),
    connection_type: stringValue(source.connection_type),
    color_scheme_preference: canonicalColorScheme(source.color_scheme_preference),
    app_version: stringValue(source.app_version) ?? config.appVersion,
    build_number: stringValue(source.build_number) ?? config.buildNumber,
    release_channel: stringValue(source.release_channel) ?? config.releaseChannel,
    api_level: nullableNonNegativeInteger(source.api_level),
    manufacturer: stringValue(source.manufacturer),
    model: stringValue(source.model),
    timezone: stringValue(source.timezone),
    battery_level: nonNegativeNumber(source.battery_level),
    battery_charging: typeof source.battery_charging === "boolean"
      ? source.battery_charging
      : typeof source.charging === "boolean" ? source.charging : null,
    free_disk_bytes: nullableNonNegativeInteger(source.free_disk_bytes),
    free_memory_bytes: nullableNonNegativeInteger(source.free_memory_bytes),
    jailbroken: typeof source.jailbroken === "boolean"
      ? source.jailbroken
      : typeof source.rooted === "boolean" ? source.rooted : null
  };
}

export function toLegacyNativeEvent(event: DebugBundleEventEnvelope): DebugBundleEventEnvelope {
  const context = event.context ?? {};
  const payload: Record<string, unknown> = { ...event.payload, context };
  if (event.event_type === "frontend_exception") {
    payload.error = {
      name: event.payload.name,
      message: event.payload.message,
      stack: event.payload.stack
    };
  } else if (event.event_type === "request_event") {
    payload.url = event.payload.path;
  }
  return { ...event, payload };
}

function canonicalDeviceType(value: unknown): "desktop" | "mobile" | "tablet" | "unknown" {
  return value === "desktop" || value === "mobile" || value === "tablet" ? value : "unknown";
}

function canonicalColorScheme(value: unknown): "light" | "dark" | "no-preference" | null {
  return value === "light" || value === "dark" || value === "no-preference" ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  return nullableNonNegativeInteger(value) ?? 0;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
