import { utf8Bytes as utf8ByteLength } from "./owned-json.js";
import { normalizeNativeState, stringValue, asRecord, objectWrap, parseRequestUrl, sanitizeScreenName, generateId, canonicalDevice, toLegacyNativeEvent, correlationFromContext, sameMobileDevice } from "./client-values.js";
import { MobileEvidenceController, fitMobileEvent } from "./evidence-controller.js";
import { normalizeCapabilities } from "./evidence-capabilities.js";
import { canonicalEvent } from "./evidence-wire.js";
import { ownJSON } from "./owned-json.js";
import { snapshotError, snapshotExceptionEvidence } from "./exception-evidence.js";
import type { EvidenceCapabilities, OperationScope, RecoveryObservation } from "./evidence-types.js";
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
const DEFAULT_SDK_VERSION = "3.1.0";
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
  private evidence: MobileEvidenceController;

  constructor(config: DebugBundleConfig = {}) {
    this.config = resolveConfig(config);
    this.evidence = new MobileEvidenceController(this.config);
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

  get evidenceCapabilities(): EvidenceCapabilities {
    return this.evidence.capabilities(this.nativeState, this.hasCanonicalBridge());
  }

  private hasCanonicalBridge(): boolean {
    return this.nativeModule?.enqueueCanonicalEventJson !== undefined || this.nativeModule?.enqueueCanonicalEvent !== undefined;
  }

  beginOperation(): OperationScope { return this.evidence.begin(); }
  withOperationContext<T>(operation: (scope: OperationScope) => T): T {
    const scope = this.beginOperation();
    try { return operation(scope); } finally { scope.close(); }
  }
  captureRecovery(observation: RecoveryObservation): void {
    if (!this.canCapture("diagnostic_context", true) || !this.hasNativeCapacity(false) ||
      !this.evidenceCapabilities.features.includes("recovery_v1")) return;
    const prepared = this.evidence.recovery(observation);
    if (prepared) this.enqueue("diagnostic_context", prepared.payload, null, true, undefined, true, true, prepared.correlation);
  }

  init(config: DebugBundleConfig): void {
    this.evidence.close();
    this.config = resolveConfig(config);
    this.evidence = new MobileEvidenceController(this.config);
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
      const initializedConfig = this.config;
      const initialization = this.nativeModule.initialize(nativeConfig(this.config));
      if (isPromiseLike(initialization)) {
        this.nativeState = { status: "healthy", lastEventAt: null, nativeModuleAvailable: true };
        void safeNativeCall(async () => {
          const state = await initialization;
          if (this.config === initializedConfig) this.nativeState = normalizeNativeState(state);
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
    const mergedContext = this.evidence.context(this.mergeContext(context), this.nativeState, this.hasCanonicalBridge());
    const sanitizedError = snapshotError(error, this.config.redactFields);
    const fatal = mergedContext.source === "react-native-global-error" && mergedContext.fatal === true;
    const graph = this.evidenceCapabilities.features.includes("exception_evidence_v1")
      ? snapshotExceptionEvidence(error, sanitizedError, this.config.redactFields, fatal) : undefined;
    this.enqueue("frontend_exception", {
      name: stringValue(sanitizedError.name) ?? "Error",
      message: stringValue(sanitizedError.message) ?? "Unknown error",
      stack: stringValue(sanitizedError.stack) ?? `${stringValue(sanitizedError.name) ?? "Error"}: ${stringValue(sanitizedError.message) ?? "Unknown error"}`,
      breadcrumbs: this.breadcrumbs.slice(),
      probe_data: this.snapshotProbeData(),
      ...(graph ? { exception_evidence: graph } : {})
    }, stringValue(mergedContext.trace_id), false, asRecord(sanitizeValue(mergedContext, {
      redactFields: this.config.redactFields
    })), this.config.captureErrors, !fatal, correlationFromContext(mergedContext));
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
      this.nativeState = normalizeNativeState(state);
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
      breadcrumb_type: ["route_change", "click", "form_submit", "console_log", "network_request"].includes(type) ? type
        : type === "screen" ? "route_change" : type === "action" ? "click" : "console_log",
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
    localPolicyAllows = true,
    runBeforeSend = true,
    correlation?: DebugBundleEventEnvelope["correlation"]
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
    let owner: string | null = null;
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
        ...(correlation ? { correlation } : traceId ? { correlation: { trace_id: traceId } } : {}),
        ...(context && Object.keys(context).length > 0 ? { context } : {}),
        payload: eventType === "diagnostic_context" ? payload : { ...payload, device: canonicalDevice(this.nativeState.device, this.config) }
      };
      const initial = protectEventFields(authoredEvent, this.config.redactFields);
      if (!initial) return;
      owner = initial.event_id;
      if (initial.event_type === "diagnostic_context" && (!canonicalEvent(ownJSON(initial)) || !this.evidence.budget.reserve(initial, owner))) return;
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
      this.sendAdmittedEvent(initial, config, nativeModule, reservedBytes, runBeforeSend, !this.nativeState.device);
    } catch {
      this.nativeState = degradedNativeState("event_preparation_failed");
    } finally {
      if (!handedOff) { this.releaseNativeCapacity(reservedBytes); if (owner) this.evidence.budget.release(owner); }
    }
  }

  private sendAdmittedEvent(
    initial: DebugBundleEventEnvelope,
    config: ResolvedDebugBundleConfig,
    nativeModule: NativeDebugBundleModule,
    reservedBytes: number,
    runBeforeSend: boolean,
    hydrateNativeDevice: boolean
  ): void {
    // This activation receives only a protected snapshot: deferred closures must
    // not retain the raw capture payload/context through their lexical scope.
      const evidence = this.evidence;
      const prepareAndSend = async (): Promise<void> => {
        if (this.config !== config) return;
        const safeEvent = this.prepareAdmittedEvent(initial, config, nativeModule.enqueueCanonicalEventJson !== undefined || nativeModule.enqueueCanonicalEvent !== undefined, runBeforeSend, hydrateNativeDevice);
        if (safeEvent === null) return;
        const finalPriority = ["frontend_exception", "backend_exception"].includes(safeEvent.event_type) ||
          safeEvent.event_type === "log_event" && ["error", "critical"].includes(String(safeEvent.payload.level));
        const eventBytes = utf8ByteLength(JSON.stringify(safeEvent));
        const finalLimit = finalPriority ? MAX_PENDING_NATIVE_BYTES : MAX_PENDING_LOW_PRIORITY_BYTES;
        // The callback closure can retain the protected original until the bridge
        // settles. Charge both it and the final snapshot instead of forgetting it.
        if (eventBytes > MAX_NATIVE_EVENT_BYTES || this.pendingNativeBytes + eventBytes > finalLimit) return;
        this.pendingNativeBytes += eventBytes;
        reservedBytes += eventBytes;
        if (safeEvent.event_type === "diagnostic_context") {
          if (!evidence.budget.replace(initial.event_id, safeEvent)) return;
        } else {
          evidence.budget.release(initial.event_id);
          if (["frontend_exception", "backend_exception"].includes(safeEvent.event_type)) evidence.budget.register(safeEvent);
        }
        // iOS TurboModule object conversion removes nested nulls. A string carrier
        // preserves the validated JSON shape; older binaries keep their existing API.
        if (nativeModule.enqueueCanonicalEventJson) await nativeModule.enqueueCanonicalEventJson(JSON.stringify(safeEvent));
        else if (nativeModule.enqueueCanonicalEvent) await nativeModule.enqueueCanonicalEvent(safeEvent);
        else await nativeModule.enqueueEvent(safeEvent);
      };
      const operation = config.beforeSend === null || !runBeforeSend
        ? safeNativeCall(prepareAndSend, undefined)
        : Promise.resolve().then(() => safeNativeCall(prepareAndSend, undefined));
      void operation.finally(() => { this.releaseNativeCapacity(reservedBytes); evidence.budget.release(initial.event_id); });
  }

  private prepareAdmittedEvent(initial: DebugBundleEventEnvelope, config: ResolvedDebugBundleConfig, canonical: boolean, runBeforeSend: boolean, hydrateNativeDevice: boolean): DebugBundleEventEnvelope | null {
    // Exit this synchronous activation before awaiting the bridge. An application
    // replacement may be huge before projection and must not survive suspension.
    const event = applyBeforeSend(initial, runBeforeSend ? config.beforeSend : null);
    if (!event || this.config !== config) return null;
    const safeEvent = protectEventFields(event, config.redactFields);
    if (!safeEvent) return null;
    if (safeEvent.event_type === "log_event" &&
        (!config.captureLogs || !(LOG_LEVELS[safeEvent.payload.level as DebugBundleLogLevel] >= LOG_LEVELS[config.logLevel]))) return null;
    if (["frontend_exception", "backend_exception"].includes(safeEvent.event_type) && !config.captureErrors) return null;
    if (!canonicalEvent(ownJSON(safeEvent))) return null;
    const filtered = this.evidence.filter(safeEvent, this.nativeState, canonical);
    if (!filtered) return null;
    const fitted = fitMobileEvent(filtered);
    if (fitted && hydrateNativeDevice && fitted.sdk_name === SDK_NAME && fitted.event_type === "frontend_exception" &&
      sameMobileDevice(initial.payload.device, fitted.payload.device)) {
      // This is the private native carrier, whose existing worker supplies device
      // metadata before wire delivery. Preserve an explicitly changed hook device.
      delete fitted.payload.device;
    }
    return fitted ? canonical ? fitted : toLegacyNativeEvent(fitted) : null;
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
    captureExceptionEvidence: config.captureExceptionEvidence ?? true,
    captureRecoveryObservations: config.captureRecoveryObservations ?? false,
    evidenceCapabilities: config.evidenceCapabilities ? normalizeCapabilities(config.evidenceCapabilities) : null,
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
