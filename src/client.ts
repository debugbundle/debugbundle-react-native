import { getNativeModule, degradedNativeState, safeNativeCall } from "./native.js";
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
  NativeDebugBundleState,
  ResolvedDebugBundleConfig
} from "./types.js";

const SDK_NAME = "@debugbundle/sdk-react-native" as const;
const DEFAULT_SDK_VERSION = "0.1.1";
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
  private sessionSampledIn = true;
  private sessionEventCount = 0;

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
    this.sessionSampledIn =
      this.config.enabled &&
      (this.config.sessionSampleRate >= 1 || Math.random() <= this.config.sessionSampleRate);
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
    void safeNativeCall(
      async () => {
        this.nativeState = await this.nativeModule!.initialize(this.config);
        if (!this.nativeState.status) {
          this.nativeState.status = "healthy";
        }
      },
      undefined
    );
    this.nativeState = { status: "healthy", lastEventAt: null, nativeModuleAvailable: true };
  }

  captureException(error: unknown, context: DebugBundleCaptureContext = {}): void {
    const mergedContext = this.mergeContext(context);
    this.enqueue("frontend_exception", {
      error: sanitizeValue(error, { redactFields: this.config.redactFields }),
      context: sanitizeValue(mergedContext, { redactFields: this.config.redactFields }),
      breadcrumbs: this.breadcrumbs.slice(),
      probe_data: this.snapshotProbeData()
    }, stringValue(mergedContext.trace_id), false);
  }

  captureError(error: unknown, context: DebugBundleCaptureContext = {}): void {
    this.captureException(error, context);
  }

  captureLog(message: string, level: DebugBundleLogLevel = "warning", context: DebugBundleCaptureContext = {}): void {
    if (!this.config.captureLogs || LOG_LEVELS[level] < LOG_LEVELS[this.config.logLevel]) {
      return;
    }
    this.enqueue("log_event", {
      level,
      message: sanitizeValue(message, { redactFields: this.config.redactFields }),
      context: sanitizeValue(this.mergeContext(context), { redactFields: this.config.redactFields }),
      source: "javascript"
    }, stringValue(context.trace_id), true);
  }

  captureRequest(
    request: DebugBundleRequestInfo,
    response: DebugBundleResponseInfo,
    context: DebugBundleCaptureContext = {}
  ): void {
    const traceId = request.traceId ?? stringValue(context.trace_id);
    const payload = {
      method: request.method,
      url: sanitizeUrl(request.url),
      route_template: request.routeTemplate ?? null,
      request_headers: sanitizeHeaders(request.headers, this.config.headerAllowlist, {
        redactFields: this.config.redactFields
      }),
      response_status: response.statusCode,
      response_headers: sanitizeHeaders(response.headers, this.config.headerAllowlist, {
        redactFields: this.config.redactFields
      }),
      duration_ms: response.durationMillis ?? null,
      source: "react-native"
    };
    this.recordBreadcrumb("network", payload);
    if (this.shouldCaptureRequestEvent(response.statusCode)) {
      this.enqueue("request_event", payload, traceId, true);
    }
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
    if (this.nativeModule?.setContext) {
      void safeNativeCall(() => this.nativeModule!.setContext!(key, this.context[key]), undefined);
    }
  }

  probe(label: string, data: unknown | (() => unknown), options: DebugBundleProbeOptions = {}): void {
    if (!label || this.probeBuffers.size >= this.config.maxProbeLabels && !this.probeBuffers.has(label)) {
      return;
    }
    if (options.heavy && !this.hasActiveJsProbeActivation()) {
      return;
    }
    const value = typeof data === "function" ? safeInvoke(data as () => unknown) : data;
    const entry = {
      label,
      data: sanitizeValue(value, { redactFields: this.config.redactFields }),
      timestamp: new Date().toISOString(),
      activation_id: null
    };
    const entries = this.probeBuffers.get(label) ?? [];
    entries.push(entry);
    this.probeBuffers.set(label, entries.slice(-this.config.maxProbeEntriesPerLabel));
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
    this.breadcrumbs.push({
      breadcrumb_type: type,
      occurred_at: new Date().toISOString(),
      data: sanitizeValue(data, { redactFields: this.config.redactFields })
    });
    this.breadcrumbs = this.breadcrumbs.slice(-this.config.maxBreadcrumbs);
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
    countTowardSession: boolean
  ): void {
    if (!this.canCapture(eventType, countTowardSession)) {
      return;
    }
    const event: DebugBundleEventEnvelope = {
      schema_version: "1",
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
      correlation: traceId ? { trace_id: traceId } : null,
      payload,
      device: this.nativeState.device ?? deviceFromConfig(this.config)
    };
    if (countTowardSession) {
      this.sessionEventCount += 1;
    }
    if (!this.nativeModule) {
      this.nativeState = degradedNativeState("native_module_unavailable");
      return;
    }
    void safeNativeCall(() => this.nativeModule!.enqueueEvent(event), undefined);
  }

  private canCapture(eventType: DebugBundleEventEnvelope["event_type"], countTowardSession: boolean): boolean {
    if (!this.config.enabled || !this.config.projectToken || !this.sessionSampledIn) {
      return false;
    }
    if (Math.random() > this.config.sampleRate) {
      return false;
    }
    if (countTowardSession && this.sessionEventCount >= this.config.maxEventsPerSession) {
      return eventType === "frontend_exception" || eventType === "probe_event";
    }
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

  private shouldCaptureRequestEvent(statusCode: number): boolean {
    return statusCode >= 500 || [408, 423, 424, 425, 429].includes(statusCode);
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
    sdkVersion: config.sdkVersion ?? DEFAULT_SDK_VERSION
  };
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url.split("?")[0] ?? url;
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

function deviceFromConfig(config: ResolvedDebugBundleConfig): Record<string, unknown> {
  return {
    app_version: config.appVersion,
    build_number: config.buildNumber,
    release_channel: config.releaseChannel
  };
}
