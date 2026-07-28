import { getNativeModule, degradedNativeState, safeNativeCall } from "./native.js";
import { applyBeforeSend } from "./before-send.js";
import { defaultRedactFields, DEFAULT_HEADER_ALLOWLIST, sanitizeHeaders, sanitizeValue } from "./redaction.js";
import type {
  DebugBundleCaptureContext,
  DebugBundleClient,
  DebugBundleConfig,
  DebugBundleEventEnvelope,
  DebugBundleLogLevel,
  DebugBundleProbeOptions,
  DebugBundleRequestInfo,
  DebugBundleResponseInfo,
  DebugBundleStatus,
  NativeDebugBundleModule,
  NativeDebugBundleConfig,
  NativeDebugBundleState,
  ResolvedDebugBundleConfig
} from "./types.js";

const SDK_NAME = "@debugbundle/sdk-react-native" as const;
const DEFAULT_SDK_VERSION = "1.2.0";
const LOG_LEVELS: Record<DebugBundleLogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  critical: 50
};

export class DebugBundleReactNativeClient implements DebugBundleClient {
  private config: ResolvedDebugBundleConfig;
  private nativeModule: NativeDebugBundleModule | null = null;
  private nativeState: NativeDebugBundleState = degradedNativeState("not_initialized");
  private context: Record<string, unknown> = {};
  private breadcrumbs: Array<Record<string, unknown>> = [];
  private probeBuffers = new Map<string, Array<Record<string, unknown>>>();
  private jsProbeActivationExpiresAt = 0;

  constructor(config: DebugBundleConfig = {}) {
    this.config = resolveConfig(config);
    if (Object.keys(config).length > 0) {
      this.init(config);
    }
  }

  get status(): DebugBundleStatus {
    return this.nativeState.status;
  }

  get lastEventAt(): number | null {
    return this.nativeState.lastEventAt ?? null;
  }

  init(config: DebugBundleConfig): void {
    this.config = resolveConfig(config);
    this.nativeModule = getNativeModule();
    if (!this.config.enabled) {
      this.nativeState = { status: "disconnected", lastEventAt: null, nativeModuleAvailable: Boolean(this.nativeModule) };
      return;
    }
    if (!this.config.projectToken || !this.config.endpoint) {
      this.nativeState = degradedNativeState("missing_project_token_or_endpoint");
      return;
    }
    if (!this.nativeModule) {
      this.nativeState = degradedNativeState("native_module_unavailable");
      return;
    }
    try {
      const initialization = this.nativeModule.initialize(nativeConfig(this.config));
      if (isPromiseLike(initialization)) {
        this.nativeState = { status: "healthy", lastEventAt: null, nativeModuleAvailable: true };
        void safeNativeCall(async () => {
          this.nativeState = normalizeNativeState(await initialization);
        }, undefined);
      } else {
        this.nativeState = normalizeNativeState(initialization);
      }
    } catch {
      this.nativeState = degradedNativeState("native_initialize_failed");
    }
  }

  captureException(error: unknown, context: DebugBundleCaptureContext = {}): void {
    const mergedContext = this.mergeContext(context);
    const sanitizedError = asRecord(sanitizeValue(error, { redactFields: this.config.redactFields }));
    this.enqueue("frontend_exception", {
      name: stringValue(sanitizedError.name) ?? "Error",
      message: stringValue(sanitizedError.message) ?? "Unknown error",
      stack: stringValue(sanitizedError.stack) ?? `${stringValue(sanitizedError.name) ?? "Error"}: ${stringValue(sanitizedError.message) ?? "Unknown error"}`,
      breadcrumbs: this.breadcrumbs.slice(),
      probe_data: this.snapshotProbeData()
    }, stringValue(mergedContext.trace_id), false, asRecord(sanitizeValue(mergedContext, {
      redactFields: this.config.redactFields
    })), this.config.captureErrors);
  }

  captureError(error: unknown, context: DebugBundleCaptureContext = {}): void {
    this.captureException(error, context);
  }

  captureLog(message: string, level: DebugBundleLogLevel = "warning", context: DebugBundleCaptureContext = {}): void {
    this.enqueue("log_event", {
      level,
      message: sanitizeValue(message, { redactFields: this.config.redactFields }),
      attributes: {
        ...asRecord(sanitizeValue(this.mergeContext(context), { redactFields: this.config.redactFields })),
        source: "javascript"
      }
    }, stringValue(context.trace_id), true, undefined,
    this.config.captureLogs && LOG_LEVELS[level] >= LOG_LEVELS[this.config.logLevel]);
  }

  captureRequest(
    request: DebugBundleRequestInfo,
    response: DebugBundleResponseInfo,
    context: DebugBundleCaptureContext = {}
  ): void {
    const mergedContext = this.mergeContext(context);
    const traceId = request.traceId ?? stringValue(mergedContext.trace_id);
    const parsedUrl = parseRequestUrl(request.url);
    const payload = {
      method: request.method,
      path: parsedUrl.path,
      query: parsedUrl.query,
      route_template: request.routeTemplate ?? null,
      headers: sanitizeHeaders(request.headers, this.config.headerAllowlist, {
        redactFields: this.config.redactFields
      }),
      response_status: response.statusCode,
      response_headers: sanitizeHeaders(response.headers, this.config.headerAllowlist, {
        redactFields: this.config.redactFields
      }),
      duration_ms: response.durationMillis ?? 0
    };
    if (this.config.captureNetwork) {
      this.recordBreadcrumb("network_request", payload);
    }
    this.enqueue(
      "request_event",
      payload,
      traceId,
      true,
      asRecord(sanitizeValue(mergedContext, { redactFields: this.config.redactFields })),
      this.config.captureNetwork
    );
  }

  captureMessage(message: string, level: DebugBundleLogLevel = "warning", context: DebugBundleCaptureContext = {}): void {
    this.recordBreadcrumb("message", {
      level,
      message: sanitizeValue(message, { redactFields: this.config.redactFields }),
      context: sanitizeValue(this.mergeContext(context), { redactFields: this.config.redactFields })
    });
  }

  setContext(key: string, value: unknown): void {
    this.context[key] = sanitizeValue(value, { redactFields: this.config.redactFields });
    if (this.nativeModule?.setContextValue) {
      void safeNativeCall(() => this.nativeModule!.setContextValue!(key, { value: this.context[key] }), undefined);
    } else if (this.nativeModule?.setContext) {
      void safeNativeCall(() => this.nativeModule!.setContext!(key, this.context[key]), undefined);
    }
  }

  probe(label: string, data: unknown | (() => unknown), options: DebugBundleProbeOptions = {}): void {
    if (!label || this.probeBuffers.size >= this.config.maxProbeLabels && !this.probeBuffers.has(label)) {
      return;
    }
    const nativeProbeActive = this.nativeModule?.isProbeActive?.(label) ?? false;
    if (options.heavy && !nativeProbeActive && !this.hasActiveJsProbeActivation()) {
      return;
    }
    const value = typeof data === "function" ? safeInvoke(data as () => unknown) : data;
    const sanitizedData = objectWrap(sanitizeValue(value, { redactFields: this.config.redactFields }));
    const occurredAt = new Date().toISOString();
    const entry = {
      label,
      data: sanitizedData,
      timestamp: occurredAt,
      activation_id: null
    };
    const entries = this.probeBuffers.get(label) ?? [];
    entries.push(entry);
    this.probeBuffers.set(label, entries.slice(-this.config.maxProbeEntriesPerLabel));
    if (this.nativeModule?.captureProbe) {
      void safeNativeCall(
        () => this.nativeModule!.captureProbe!(label, sanitizedData, occurredAt),
        false
      );
    }
  }

  async flush(): Promise<void> {
    if (!this.nativeModule) {
      return;
    }
    await safeNativeCall(async () => {
      await this.nativeModule!.flush();
      const state = await this.nativeModule!.getStatus();
      this.nativeState = state;
    }, undefined);
  }

  async activateProbeTriggerToken(token: string): Promise<boolean> {
    if (!this.nativeModule?.activateProbeTriggerToken) {
      return false;
    }
    const activated = await safeNativeCall(() => this.nativeModule!.activateProbeTriggerToken!(token), false);
    if (activated) {
      this.jsProbeActivationExpiresAt = Date.now() + 60 * 60 * 1000;
    }
    return activated;
  }

  recordBreadcrumb(type: string, data: Record<string, unknown> = {}): void {
    const breadcrumb = {
      breadcrumb_type: type,
      ts: new Date().toISOString(),
      data: sanitizeValue(data, { redactFields: this.config.redactFields })
    };
    this.breadcrumbs.push(breadcrumb);
    this.breadcrumbs = this.breadcrumbs.slice(-this.config.maxBreadcrumbs);
    this.enqueue("frontend_breadcrumb", {
      breadcrumb_type: type,
      data: breadcrumb.data
    }, null, true);
  }

  recordScreen(screenName: string, previousScreen: string | null = null, source = "react-navigation"): void {
    if (!this.config.captureScreens) {
      return;
    }
    this.recordBreadcrumb("screen", {
      screen_name: sanitizeScreenName(screenName),
      previous_screen: previousScreen ? sanitizeScreenName(previousScreen) : null,
      source
    });
  }

  private enqueue(
    eventType: DebugBundleEventEnvelope["event_type"],
    payload: Record<string, unknown>,
    traceId: string | null,
    countTowardSession: boolean,
    context?: Record<string, unknown>,
    localPolicyAllows = true
  ): void {
    if (!this.canCapture(eventType, countTowardSession)) {
      return;
    }
    const authoredEvent: DebugBundleEventEnvelope = {
      schema_version: "2026-03-01",
      event_id: generateId(),
      event_type: eventType,
      sdk_name: SDK_NAME,
      sdk_version: this.config.sdkVersion,
      service: {
        name: this.config.service,
        environment: this.config.environment,
        runtime: "react-native",
        framework: "react-native"
      },
      occurred_at: new Date().toISOString(),
      ...(traceId ? { correlation: { trace_id: traceId } } : {}),
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
      payload: this.nativeState.device
        ? { ...payload, device: canonicalDevice(this.nativeState.device, this.config) }
        : payload
    };
    const event = applyBeforeSend(authoredEvent, this.config.beforeSend);
    if (!event || !localPolicyAllows) {
      return;
    }
    if (!this.nativeModule) {
      this.nativeState = degradedNativeState("native_module_unavailable");
      return;
    }
    if (this.nativeModule.enqueueCanonicalEvent) {
      void safeNativeCall(() => this.nativeModule!.enqueueCanonicalEvent!(event), undefined);
    } else {
      void safeNativeCall(() => this.nativeModule!.enqueueEvent(toLegacyNativeEvent(event)), undefined);
    }
  }

  private canCapture(eventType: DebugBundleEventEnvelope["event_type"], countTowardSession: boolean): boolean {
    if (!this.config.enabled || !this.config.projectToken) {
      return false;
    }
    void eventType;
    void countTowardSession;
    return true;
  }

  private mergeContext(context: DebugBundleCaptureContext): Record<string, unknown> {
    return { ...this.context, ...context };
  }

  private snapshotProbeData(): Record<string, unknown> {
    if (!this.config.probeFlushOnError) {
      return { version: 1, items: [] };
    }
    return {
      version: 1,
      items: [...this.probeBuffers.values()].flat()
    };
  }

  private hasActiveJsProbeActivation(): boolean {
    return this.jsProbeActivationExpiresAt > Date.now();
  }

}

export function createDebugBundleClient(config: DebugBundleConfig = {}): DebugBundleReactNativeClient {
  return new DebugBundleReactNativeClient(config);
}

export function resolveConfig(config: DebugBundleConfig): ResolvedDebugBundleConfig {
  return {
    projectToken: config.projectToken ?? "",
    enabled: config.enabled ?? true,
    environment: config.environment ?? "production",
    service: config.service ?? "react-native-app",
    endpoint: config.endpoint ?? "https://api.debugbundle.com/v1/events",
    releaseChannel: config.releaseChannel ?? "production",
    appVersion: config.appVersion ?? null,
    buildNumber: config.buildNumber ?? null,
    batchSize: clampInteger(config.batchSize, 10, 1, 100),
    flushInterval: clampInteger(config.flushInterval, 3000, 100, 60000),
    sampleRate: clampRate(config.sampleRate),
    sessionSampleRate: clampRate(config.sessionSampleRate),
    maxEventsPerSession: clampInteger(config.maxEventsPerSession, 100, 1, 10000),
    maxBreadcrumbs: clampInteger(config.maxBreadcrumbs, 20, 1, 200),
    captureErrors: config.captureErrors ?? true,
    captureUnhandledRejections: config.captureUnhandledRejections ?? true,
    captureScreens: config.captureScreens ?? true,
    captureActions: config.captureActions ?? false,
    captureNetwork: config.captureNetwork ?? true,
    captureConsole: config.captureConsole ?? false,
    captureLogs: config.captureLogs ?? true,
    logLevel: config.logLevel ?? "warning",
    tracePropagationTargets: config.tracePropagationTargets ?? [],
    networkFilter: config.networkFilter ?? {},
    offlineQueueMaxEvents: clampInteger(config.offlineQueueMaxEvents, 500, 1, 10000),
    offlineQueueMaxBytes: clampInteger(config.offlineQueueMaxBytes, 5 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    offlineQueueTtl: clampInteger(config.offlineQueueTtl, 72 * 60 * 60 * 1000, 60000, 30 * 24 * 60 * 60 * 1000),
    requestTimeout: clampInteger(config.requestTimeout, 5000, 100, 60000),
    maxProbeLabels: clampInteger(config.maxProbeLabels, 50, 1, 500),
    maxProbeEntriesPerLabel: clampInteger(config.maxProbeEntriesPerLabel, 10, 1, 200),
    probeFlushOnError: config.probeFlushOnError ?? true,
    redactFields: config.redactFields ?? defaultRedactFields(),
    headerAllowlist: config.headerAllowlist ?? DEFAULT_HEADER_ALLOWLIST,
    sdkVersion: config.sdkVersion ?? DEFAULT_SDK_VERSION,
    beforeSend: config.beforeSend ?? null
  };
}

function nativeConfig(config: ResolvedDebugBundleConfig): NativeDebugBundleConfig {
  const { beforeSend: _beforeSend, ...native } = config;
  return native;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value!)));
}

function clampRate(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value!));
}

function safeInvoke(producer: () => unknown): unknown {
  try {
    return producer();
  } catch (error) {
    return { error: sanitizeValue(error) };
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as Promise<T>).then === "function");
}

function normalizeNativeState(state: NativeDebugBundleState): NativeDebugBundleState {
  return {
    ...state,
    status: state.status || "healthy",
    nativeModuleAvailable: state.nativeModuleAvailable ?? true
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function objectWrap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function parseRequestUrl(url: string): { path: string; query: Record<string, unknown> } {
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

function sanitizeScreenName(screenName: string): string {
  return screenName.replace(/[^a-zA-Z0-9_.:/-]/g, "_").slice(0, 120);
}

function generateId(): string {
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

function canonicalDevice(
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

function toLegacyNativeEvent(event: DebugBundleEventEnvelope): DebugBundleEventEnvelope {
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
