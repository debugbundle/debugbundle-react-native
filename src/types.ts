export type DebugBundleStatus = "healthy" | "degraded" | "disconnected";

export type DebugBundleLogLevel = "debug" | "info" | "warning" | "error" | "critical";

export type DebugBundleBeforeSend = (
  event: DebugBundleEventEnvelope
) => DebugBundleEventEnvelope | null;

export interface DebugBundleConfig {
  projectToken?: string;
  enabled?: boolean;
  environment?: string;
  service?: string;
  endpoint?: string;
  releaseChannel?: string;
  appVersion?: string;
  buildNumber?: string;
  batchSize?: number;
  flushInterval?: number;
  sampleRate?: number;
  sessionSampleRate?: number;
  maxEventsPerSession?: number;
  maxBreadcrumbs?: number;
  captureErrors?: boolean;
  captureUnhandledRejections?: boolean;
  captureScreens?: boolean;
  captureActions?: boolean;
  captureNetwork?: boolean;
  captureConsole?: boolean;
  captureLogs?: boolean;
  logLevel?: DebugBundleLogLevel;
  tracePropagationTargets?: string[];
  networkFilter?: DebugBundleNetworkFilter;
  offlineQueueMaxEvents?: number;
  offlineQueueMaxBytes?: number;
  offlineQueueTtl?: number;
  requestTimeout?: number;
  maxProbeLabels?: number;
  maxProbeEntriesPerLabel?: number;
  probeFlushOnError?: boolean;
  redactFields?: string[];
  headerAllowlist?: string[];
  sdkVersion?: string;
  beforeSend?: DebugBundleBeforeSend;
}

export interface ResolvedDebugBundleConfig {
  projectToken: string;
  enabled: boolean;
  environment: string;
  service: string;
  endpoint: string;
  releaseChannel: string;
  appVersion: string | null;
  buildNumber: string | null;
  batchSize: number;
  flushInterval: number;
  sampleRate: number;
  sessionSampleRate: number;
  maxEventsPerSession: number;
  maxBreadcrumbs: number;
  captureErrors: boolean;
  captureUnhandledRejections: boolean;
  captureScreens: boolean;
  captureActions: boolean;
  captureNetwork: boolean;
  captureConsole: boolean;
  captureLogs: boolean;
  logLevel: DebugBundleLogLevel;
  tracePropagationTargets: string[];
  networkFilter: DebugBundleNetworkFilter;
  offlineQueueMaxEvents: number;
  offlineQueueMaxBytes: number;
  offlineQueueTtl: number;
  requestTimeout: number;
  maxProbeLabels: number;
  maxProbeEntriesPerLabel: number;
  probeFlushOnError: boolean;
  redactFields: string[];
  headerAllowlist: string[];
  sdkVersion: string;
  beforeSend: DebugBundleBeforeSend | null;
}

export interface DebugBundleNetworkFilter {
  urlAllowlist?: string[];
  urlDenylist?: string[];
  statusCodes?: number[];
  minResponseTime?: number;
}

export interface DebugBundleRequestInfo {
  method: string;
  url: string;
  headers?: Record<string, string>;
  routeTemplate?: string;
  traceId?: string;
}

export interface DebugBundleResponseInfo {
  statusCode: number;
  durationMillis?: number;
  headers?: Record<string, string>;
}

export interface DebugBundleCaptureContext {
  [key: string]: unknown;
}

export interface DebugBundleProbeOptions {
  heavy?: boolean;
}

export interface DebugBundleEventEnvelope {
  schema_version: "2026-03-01";
  event_id: string;
  event_type:
    | "frontend_exception"
    | "frontend_breadcrumb"
    | "log_event"
    | "request_event"
    | "error_suppressed"
    | "probe_event";
  sdk_name: "@debugbundle/sdk-react-native";
  sdk_version: string;
  service: {
    name: string;
    environment: string;
    runtime: "react-native";
    framework: "react-native";
  };
  occurred_at: string;
  correlation?: {
    trace_id: string | null;
    request_id?: string | null;
    session_id?: string | null;
    user_id_hash?: string | null;
  };
  context?: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export interface DebugBundleClient {
  readonly status: DebugBundleStatus;
  readonly lastEventAt: number | null;
  init(config: DebugBundleConfig): void;
  captureException(error: unknown, context?: DebugBundleCaptureContext): void;
  captureError(error: unknown, context?: DebugBundleCaptureContext): void;
  captureLog(message: string, level?: DebugBundleLogLevel, context?: DebugBundleCaptureContext): void;
  captureRequest(
    request: DebugBundleRequestInfo,
    response: DebugBundleResponseInfo,
    context?: DebugBundleCaptureContext
  ): void;
  captureMessage(message: string, level?: DebugBundleLogLevel, context?: DebugBundleCaptureContext): void;
  setContext(key: string, value: unknown): void;
  probe(label: string, data: unknown | (() => unknown), options?: DebugBundleProbeOptions): void;
  flush(): Promise<void>;
  activateProbeTriggerToken(token: string): Promise<boolean>;
  recordBreadcrumb(type: string, data?: Record<string, unknown>): void;
  recordScreen(screenName: string, previousScreen?: string | null, source?: string): void;
}

export interface NativeDebugBundleModule {
  initialize(config: NativeDebugBundleConfig): Promise<NativeDebugBundleState> | NativeDebugBundleState;
  enqueueCanonicalEvent?(event: DebugBundleEventEnvelope): Promise<boolean | void> | boolean | void;
  /** Compatibility fallback implemented by native binaries released before the canonical bridge. */
  enqueueEvent(event: DebugBundleEventEnvelope): Promise<void> | void;
  captureProbe?(
    label: string,
    data: unknown,
    occurredAt: string
  ): Promise<boolean> | boolean;
  isProbeActive?(label: string): boolean;
  flush(): Promise<void> | void;
  getStatus(): Promise<NativeDebugBundleState> | NativeDebugBundleState;
  setContext?(key: string, value: unknown): Promise<void> | void;
  setContextValue?(key: string, entry: { value: unknown }): Promise<void> | void;
  activateProbeTriggerToken?(token: string): Promise<boolean> | boolean;
}

export type NativeDebugBundleConfig = Omit<ResolvedDebugBundleConfig, "beforeSend">;

export interface NativeDebugBundleState {
  status: DebugBundleStatus;
  lastEventAt?: number | null;
  device?: Record<string, unknown> | null;
  nativeModuleAvailable?: boolean;
  degradedReason?: string | null;
}
