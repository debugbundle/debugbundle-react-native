import { getNativeModule, degradedNativeState, safeNativeCall } from "./native.js";
import { applyBeforeSend } from "./before-send.js";
import { defaultRedactFields, DEFAULT_HEADER_ALLOWLIST, sanitizeHeaders, sanitizeValue } from "./redaction.js";
import { sanitizeTelemetry } from "./privacy-telemetry.js";
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
const DEFAULT_SDK_VERSION = "3.0.0";
const MAX_PENDING_NATIVE_CALLS = 256;
const MAX_PENDING_LOW_PRIORITY_CALLS = 224;
const MAX_PENDING_NATIVE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_LOW_PRIORITY_BYTES = 3 * 1024 * 1024;
const MAX_NATIVE_EVENT_BYTES = 64 * 1024;
const MAX_CONTEXT_FIELDS = 50;
const MAX_CONTEXT_KEY_LENGTH = 128;
const LOG_LEVELS: Record<DebugBundleLogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  critical: 50
};

function protectEventFields(
  event: DebugBundleEventEnvelope,
  additionalKeys: string[]
): DebugBundleEventEnvelope | null {
  // Preserve typed identities only when their scalar values pass the mandatory policy.
  for (const value of [event.schema_version, event.sdk_name, event.sdk_version,
    ...Object.values(event.correlation ?? {})]) {
    if (typeof value !== "string") continue;
    const checked = sanitizeTelemetry(value, { additionalKeys });
    if (!checked.ok || checked.value !== value) return null;
  }
  const result = sanitizeTelemetry({
    service: event.service,
    payload: event.payload,
    ...(event.context ? { context: event.context } : {})
  }, { additionalKeys });
  if (!result.ok || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) {
    return null;
  }
  const safeFields = result.value as Record<string, unknown>;
  if (!safeFields.service || !safeFields.payload ||
      typeof safeFields.service !== "object" || Array.isArray(safeFields.service) ||
      typeof safeFields.payload !== "object" || Array.isArray(safeFields.payload)) {
    return null;
  }
  return {
    ...event,
    service: safeFields.service as DebugBundleEventEnvelope["service"],
    payload: safeFields.payload as Record<string, unknown>,
    ...(event.context ? { context: safeFields.context as Record<string, unknown> } : {})
  };
}

export class DebugBundleReactNativeClient implements DebugBundleClient {
  private config: ResolvedDebugBundleConfig;
  private nativeModule: NativeDebugBundleModule | null = null;
  private nativeState: NativeDebugBundleState = degradedNativeState("not_initialized");
  private context: Record<string, unknown> = {};
  private breadcrumbs: Array<Record<string, unknown>> = [];
  private probeBuffers = new Map<string, Array<Record<string, unknown>>>();
  private jsProbeActivationExpiresAt = 0;
  private pendingNativeCalls = 0;
  private pendingNativeBytes = 0;

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
    if (!this.config.captureErrors || !this.canCapture("frontend_exception", false) ||
        !this.hasNativeCapacity(true)) return;
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
    if (!this.isLogEnabled(level)) return;
    const mergedContext = this.mergeContext(context);
    this.enqueue("log_event", {
      level,
      message: sanitizeValue(message, { redactFields: this.config.redactFields }),
      attributes: {
        ...asRecord(sanitizeValue(mergedContext, { redactFields: this.config.redactFields })),
        source: "javascript"
      }
    }, stringValue(mergedContext.trace_id), true);
  }

  isLogEnabled(level: DebugBundleLogLevel): boolean {
    const rank = LOG_LEVELS[level];
    return rank !== undefined && this.config.captureLogs && rank >= LOG_LEVELS[this.config.logLevel] &&
      this.canCapture("log_event", true) && this.hasNativeCapacity(rank >= LOG_LEVELS.error);
  }

  captureRequest(
    request: DebugBundleRequestInfo,
    response: DebugBundleResponseInfo,
    context: DebugBundleCaptureContext = {}
  ): void {
    if (!this.config.captureNetwork || !this.canCapture("request_event", true) || !this.hasNativeCapacity(false)) return;
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
    this.recordBreadcrumb("network_request", payload);
    this.enqueue(
      "request_event",
      payload,
      traceId,
      true,
      asRecord(sanitizeValue(mergedContext, { redactFields: this.config.redactFields }))
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
    if (typeof key !== "string" || !key || key.length > MAX_CONTEXT_KEY_LENGTH ||
        !this.hasNativeCapacity(false) ||
        !Object.hasOwn(this.context, key) && Object.keys(this.context).length >= MAX_CONTEXT_FIELDS) return;
    try {
      // Include the field name in mandatory privacy before local or native ownership.
      const fields = asRecord(sanitizeValue({ [key]: value }, { redactFields: this.config.redactFields }));
      if (!Object.hasOwn(fields, key)) return;
      const entry = { value: fields[key] };
      this.context = { ...this.context, [key]: entry.value };
      const nativeModule = this.nativeModule;
      if (nativeModule?.setContextValue) {
        this.enqueueNativeAuxiliary({ key, entry }, () => nativeModule.setContextValue!(key, entry));
      } else if (nativeModule?.setContext) {
        this.enqueueNativeAuxiliary({ key, entry }, () => nativeModule.setContext!(key, entry.value));
      }
    } catch {
      // Context accessors and optional native integrations cannot escape into the host.
    }
  }

  probe(label: string, data: unknown | (() => unknown), options: DebugBundleProbeOptions = {}): void {
    if (!label || label.length > MAX_CONTEXT_KEY_LENGTH || !this.hasNativeCapacity(false) ||
        this.probeBuffers.size >= this.config.maxProbeLabels && !this.probeBuffers.has(label)) return;
    try {
      const nativeModule = this.nativeModule;
      const nativeProbeActive = nativeModule?.isProbeActive?.(label) ?? false;
      if (options.heavy && !nativeProbeActive && !this.hasActiveJsProbeActivation()) return;
      const value = typeof data === "function" ? safeInvoke(data as () => unknown) : data;
      const sanitizedData = objectWrap(sanitizeValue(value, { redactFields: this.config.redactFields }));
      const occurredAt = new Date().toISOString();
      const entry = { label, data: sanitizedData, timestamp: occurredAt, activation_id: null };
      const entries = this.probeBuffers.get(label) ?? [];
      entries.push(entry);
      this.probeBuffers.set(label, entries.slice(-this.config.maxProbeEntriesPerLabel));
      if (nativeModule?.captureProbe) {
        this.enqueueNativeAuxiliary({ label, data: sanitizedData, occurredAt },
          () => nativeModule.captureProbe!(label, sanitizedData, occurredAt));
      }
    } catch {
      // Probe options, native activation readers and data access cannot throw into the host.
    }
  }

  private enqueueNativeAuxiliary(payload: unknown, operation: () => unknown): void {
    if (!this.hasNativeCapacity(false)) return;
    const bytes = utf8ByteLength(JSON.stringify(payload));
    if (bytes > MAX_NATIVE_EVENT_BYTES || this.pendingNativeBytes + bytes > MAX_PENDING_LOW_PRIORITY_BYTES) return;
    this.pendingNativeCalls += 1;
    this.pendingNativeBytes += bytes;
    void safeNativeCall(operation, undefined).finally(() => this.releaseNativeCapacity(bytes));
  }

  async flush(): Promise<void> {
    // Hook preparation queued by earlier capture calls must reach the bridge first.
    await Promise.resolve();
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
    if (!localPolicyAllows) return;
    if (!this.canCapture(eventType, countTowardSession)) {
      return;
    }
    const highPriority = eventType === "frontend_exception" ||
      eventType === "log_event" && (payload.level === "error" || payload.level === "critical");
    if (!this.hasNativeCapacity(highPriority)) return;
    this.pendingNativeCalls += 1;
    let handedOff = false;
    let reservedBytes = 0;
    try {
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
      const initial = protectEventFields(authoredEvent, this.config.redactFields);
      if (!initial) return;
      const config = this.config;
      const nativeModule = this.nativeModule;
      const initialBytes = utf8ByteLength(JSON.stringify(initial));
      const byteLimit = highPriority ? MAX_PENDING_NATIVE_BYTES : MAX_PENDING_LOW_PRIORITY_BYTES;
      if (initialBytes > MAX_NATIVE_EVENT_BYTES || this.pendingNativeBytes + initialBytes > byteLimit) return;
      this.pendingNativeBytes += initialBytes;
      reservedBytes = initialBytes;
      if (!nativeModule) {
        this.nativeState = degradedNativeState("native_module_unavailable");
        return;
      }
      handedOff = true;
      this.sendAdmittedEvent(initial, config, nativeModule, reservedBytes);
    } catch {
      this.nativeState = degradedNativeState("event_preparation_failed");
    } finally {
      if (!handedOff) this.releaseNativeCapacity(reservedBytes);
    }
  }

  private sendAdmittedEvent(
    initial: DebugBundleEventEnvelope,
    config: ResolvedDebugBundleConfig,
    nativeModule: NativeDebugBundleModule,
    reservedBytes: number
  ): void {
    // This activation receives only a protected snapshot: deferred closures must
    // not retain the raw capture payload/context through their lexical scope.
      const prepareAndSend = async (): Promise<void> => {
        if (this.config !== config) return;
        const safeEvent = this.prepareAdmittedEvent(initial, config, nativeModule.enqueueCanonicalEvent !== undefined);
        if (safeEvent === null) return;
        const finalPriority = safeEvent.event_type === "frontend_exception" ||
          safeEvent.event_type === "log_event" && ["error", "critical"].includes(String(safeEvent.payload.level));
        const eventBytes = utf8ByteLength(JSON.stringify(safeEvent));
        const finalLimit = finalPriority ? MAX_PENDING_NATIVE_BYTES : MAX_PENDING_LOW_PRIORITY_BYTES;
        // The callback closure can retain the protected original until the bridge
        // settles. Charge both it and the final snapshot instead of forgetting it.
        if (eventBytes > MAX_NATIVE_EVENT_BYTES || this.pendingNativeBytes + eventBytes > finalLimit) return;
        this.pendingNativeBytes += eventBytes;
        reservedBytes += eventBytes;
        if (nativeModule.enqueueCanonicalEvent) await nativeModule.enqueueCanonicalEvent(safeEvent);
        else await nativeModule.enqueueEvent(safeEvent);
      };
      const operation = config.beforeSend === null
        ? safeNativeCall(prepareAndSend, undefined)
        : Promise.resolve().then(() => safeNativeCall(prepareAndSend, undefined));
      void operation.finally(() => { this.releaseNativeCapacity(reservedBytes); });
  }

  private prepareAdmittedEvent(initial: DebugBundleEventEnvelope, config: ResolvedDebugBundleConfig, canonical: boolean): DebugBundleEventEnvelope | null {
    // Exit this synchronous activation before awaiting the bridge. An application
    // replacement may be huge before projection and must not survive suspension.
    const event = applyBeforeSend(initial, config.beforeSend);
    if (!event || this.config !== config) return null;
    const safeEvent = protectEventFields(event, config.redactFields);
    if (!safeEvent) return null;
    if (safeEvent.event_type === "log_event" &&
        (!config.captureLogs || !(LOG_LEVELS[safeEvent.payload.level as DebugBundleLogLevel] >= LOG_LEVELS[config.logLevel]))) return null;
    if (safeEvent.event_type === "frontend_exception" && !config.captureErrors) return null;
    return canonical ? safeEvent : toLegacyNativeEvent(safeEvent);
  }

  private hasNativeCapacity(highPriority: boolean): boolean {
    return this.pendingNativeCalls < (highPriority ? MAX_PENDING_NATIVE_CALLS : MAX_PENDING_LOW_PRIORITY_CALLS) &&
      this.pendingNativeBytes < (highPriority ? MAX_PENDING_NATIVE_BYTES : MAX_PENDING_LOW_PRIORITY_BYTES);
  }

  private releaseNativeCapacity(bytes: number): void {
    this.pendingNativeCalls -= 1;
    this.pendingNativeBytes -= bytes;
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
    try {
      return { ...this.context, ...context };
    } catch {
      // A hostile caller accessor cannot interrupt error reporting or application work.
      return { ...this.context };
    }
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

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
             value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
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
