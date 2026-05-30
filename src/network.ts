import { DebugBundle } from "./index.js";
import { sanitizeHeaders } from "./redaction.js";
import type { DebugBundleClient, DebugBundleConfig, DebugBundleNetworkFilter } from "./types.js";

const TRACE_HEADER = "X-DebugBundle-Trace-Id";
let fetchRestore: (() => void) | null = null;
let xhrRestore: (() => void) | null = null;

export interface NetworkInstrumentationOptions {
  client?: DebugBundleClient;
  tracePropagationTargets?: string[];
  captureNetwork?: boolean;
  networkFilter?: DebugBundleNetworkFilter;
  headerAllowlist?: string[];
  redactFields?: string[];
}

export function instrumentDebugBundleNetwork(options: NetworkInstrumentationOptions = {}): () => void {
  const client = options.client ?? DebugBundle;
  const fetchTarget = globalThis as typeof globalThis & { fetch?: typeof fetch; XMLHttpRequest?: typeof XMLHttpRequest };
  if (fetchTarget.fetch && !fetchRestore) {
    const originalFetch = fetchTarget.fetch.bind(globalThis);
    fetchTarget.fetch = createInstrumentedFetch(originalFetch, client, options) as typeof fetch;
    fetchRestore = () => {
      fetchTarget.fetch = originalFetch;
      fetchRestore = null;
    };
  }
  if (fetchTarget.XMLHttpRequest && !xhrRestore) {
    xhrRestore = instrumentXMLHttpRequest(fetchTarget.XMLHttpRequest, client, options);
  }
  return () => {
    fetchRestore?.();
    xhrRestore?.();
  };
}

export function createInstrumentedFetch(
  originalFetch: typeof fetch,
  client: Pick<DebugBundleClient, "captureRequest">,
  options: NetworkInstrumentationOptions
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const startedAt = Date.now();
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    const traceId = shouldInjectTrace(url, options.tracePropagationTargets ?? []) ? existingTraceHeader(input, init) ?? generateTraceId() : null;
    const nextInit = traceId ? withTraceHeader(init, traceId) : init;
    try {
      const response = await originalFetch(input, nextInit);
      maybeCaptureNetwork(client, options, url, method, traceId, response.status, Date.now() - startedAt, headersToRecord(nextInit?.headers));
      return response;
    } catch (error) {
      maybeCaptureNetwork(client, options, url, method, traceId, 0, Date.now() - startedAt, headersToRecord(nextInit?.headers));
      throw error;
    }
  }) as typeof fetch;
}

export function shouldInjectTrace(url: string, targets: string[]): boolean {
  if (isRelativeUrl(url)) {
    return true;
  }
  return targets.some((target) => matchesTarget(url, target));
}

function instrumentXMLHttpRequest(
  OriginalXHR: typeof XMLHttpRequest,
  client: DebugBundleClient,
  options: NetworkInstrumentationOptions
): () => void {
  const proto = OriginalXHR.prototype as XMLHttpRequest & {
    __debugBundleWrapped?: boolean;
    __debugBundleUrl?: string;
    __debugBundleMethod?: string;
    __debugBundleStartedAt?: number;
    __debugBundleTraceId?: string | null;
  };
  if (proto.__debugBundleWrapped) {
    return () => undefined;
  }
  const originalOpen = proto.open;
  const originalSend = proto.send;
  const originalSetRequestHeader = proto.setRequestHeader;
  proto.open = function open(method: string, url: string | URL) {
    this.__debugBundleMethod = method;
    this.__debugBundleUrl = String(url);
    return originalOpen.apply(this, arguments as unknown as Parameters<typeof originalOpen>);
  };
  proto.send = function send() {
    const url = this.__debugBundleUrl ?? "";
    const traceId = shouldInjectTrace(url, options.tracePropagationTargets ?? []) ? generateTraceId() : null;
    this.__debugBundleTraceId = traceId;
    this.__debugBundleStartedAt = Date.now();
    if (traceId) {
      originalSetRequestHeader.call(this, TRACE_HEADER, traceId);
    }
    this.addEventListener("loadend", () => {
      maybeCaptureNetwork(
        client,
        options,
        url,
        this.__debugBundleMethod ?? "GET",
        this.__debugBundleTraceId ?? null,
        this.status,
        Date.now() - (this.__debugBundleStartedAt ?? Date.now()),
        traceId ? { [TRACE_HEADER]: traceId } : {}
      );
    });
    return originalSend.apply(this, arguments as unknown as Parameters<typeof originalSend>);
  };
  proto.__debugBundleWrapped = true;
  return () => {
    proto.open = originalOpen;
    proto.send = originalSend;
    proto.__debugBundleWrapped = false;
  };
}

function maybeCaptureNetwork(
  client: Pick<DebugBundleClient, "captureRequest">,
  options: NetworkInstrumentationOptions,
  url: string,
  method: string,
  traceId: string | null,
  statusCode: number,
  durationMillis: number,
  headers: Record<string, string>
): void {
  if (options.captureNetwork === false || !matchesNetworkFilter(url, statusCode, durationMillis, options.networkFilter)) {
    return;
  }
  const sanitizeOptions = options.redactFields ? { redactFields: options.redactFields } : {};
  client.captureRequest(
    {
      method,
      url,
      headers: sanitizeHeaders(headers, options.headerAllowlist, sanitizeOptions),
      ...(traceId ? { traceId } : {})
    },
    { statusCode, durationMillis },
    traceId ? { trace_id: traceId } : undefined
  );
}

function matchesNetworkFilter(url: string, statusCode: number, durationMillis: number, filter: DebugBundleNetworkFilter = {}): boolean {
  if (filter.urlDenylist?.some((entry) => url.includes(entry))) {
    return false;
  }
  if (filter.urlAllowlist && filter.urlAllowlist.length > 0 && !filter.urlAllowlist.some((entry) => url.includes(entry))) {
    return false;
  }
  if (filter.statusCodes && filter.statusCodes.length > 0 && !filter.statusCodes.includes(statusCode)) {
    return false;
  }
  if (filter.minResponseTime !== undefined && durationMillis < filter.minResponseTime) {
    return false;
  }
  return statusCode === 0 || statusCode >= 400 || filter.statusCodes !== undefined || filter.minResponseTime !== undefined;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return "url" in input ? input.url : String(input);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return init.method.toUpperCase();
  }
  if (typeof input === "object" && "method" in input && typeof input.method === "string") {
    return input.method.toUpperCase();
  }
  return "GET";
}

function withTraceHeader(init: RequestInit | undefined, traceId: string): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has(TRACE_HEADER)) {
    headers.set(TRACE_HEADER, traceId);
  }
  return { ...init, headers };
}

function existingTraceHeader(input: RequestInfo | URL, init?: RequestInit): string | null {
  const fromInit = init?.headers ? new Headers(init.headers).get(TRACE_HEADER) : null;
  if (fromInit) {
    return fromInit;
  }
  if (typeof input === "object" && "headers" in input) {
    return new Headers(input.headers).get(TRACE_HEADER);
  }
  return null;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  if (!headers) {
    return output;
  }
  new Headers(headers).forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

function isRelativeUrl(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

function matchesTarget(url: string, target: string): boolean {
  if (!target || target.includes("*")) {
    return false;
  }
  try {
    const parsedUrl = new URL(url);
    const parsedTarget = new URL(target);
    return parsedUrl.origin === parsedTarget.origin && parsedUrl.pathname.startsWith(parsedTarget.pathname.replace(/\/$/, ""));
  } catch {
    return false;
  }
}

function generateTraceId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (marker) => {
    const random = Math.trunc(Math.random() * 16);
    const value = marker === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export type { DebugBundleConfig };
