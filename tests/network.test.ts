import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInstrumentedFetch,
  instrumentDebugBundleNetwork,
  shouldInjectTrace
} from "../src/network.js";
import type { DebugBundleClient } from "../src/types.js";

describe("network instrumentation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("injects trace IDs only into relative or configured first-party targets", () => {
    expect(shouldInjectTrace("/checkout", [])).toBe(true);
    expect(shouldInjectTrace("//cdn.example.com/checkout", [])).toBe(false);
    expect(shouldInjectTrace("https://api.example.com/v1/orders", ["https://api.example.com"])).toBe(true);
    expect(shouldInjectTrace("https://api.example.com/v1/orders", ["https://api.example.com/v1/"])).toBe(true);
    expect(shouldInjectTrace("https://third-party.example/pay", ["https://api.example.com"])).toBe(false);
    expect(shouldInjectTrace("not a URL", ["not a target"])).toBe(false);
    expect(shouldInjectTrace("https://api.example.com/v1/orders", [""])).toBe(false);
    expect(shouldInjectTrace("https://api.example.com/v1/orders", ["https://*.example.com"])).toBe(false);
  });

  it("preserves caller-provided trace IDs and captures failed first-party requests", async () => {
    const captureRequest = vi.fn();
    const client = { captureRequest } as unknown as DebugBundleClient;
    const originalFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-DebugBundle-Trace-Id")).toBe("trace-1");
      return new Response("", { status: 503 });
    });
    const instrumented = createInstrumentedFetch(originalFetch as typeof fetch, client, {
      tracePropagationTargets: ["https://api.example.com"]
    });

    await instrumented("https://api.example.com/v1/orders", {
      headers: { "X-DebugBundle-Trace-Id": "trace-1", authorization: "secret" }
    });

    expect(captureRequest).toHaveBeenCalledTimes(1);
    expect(captureRequest.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      traceId: "trace-1",
      headers: { "x-debugbundle-trace-id": "trace-1" }
    });
    expect(captureRequest.mock.calls[0]?.[1]).toMatchObject({ statusCode: 503 });
  });

  it("does not inject into third-party absolute URLs", async () => {
    const originalFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("X-DebugBundle-Trace-Id")).toBe(false);
      return new Response("", { status: 200 });
    });
    const instrumented = createInstrumentedFetch(originalFetch as typeof fetch, { captureRequest: vi.fn() }, {
      tracePropagationTargets: ["https://api.example.com"]
    });

    await instrumented("https://analytics.example/collect");
  });

  it("captures rejected relative fetches with generated trace context and rethrows", async () => {
    vi.stubGlobal("crypto", {});
    vi.spyOn(Math, "random").mockReturnValue(0.25);
    const captureRequest = vi.fn();
    const failure = new Error("offline");
    const originalFetch = vi.fn(async () => {
      throw failure;
    });
    const instrumented = createInstrumentedFetch(originalFetch as typeof fetch, { captureRequest }, {});

    await expect(instrumented("/checkout", { method: "post" })).rejects.toBe(failure);

    const headers = new Headers(originalFetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-DebugBundle-Trace-Id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(captureRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "/checkout",
        traceId: headers.get("X-DebugBundle-Trace-Id")
      }),
      expect.objectContaining({ statusCode: 0 }),
      { trace_id: headers.get("X-DebugBundle-Trace-Id") }
    );
  });

  it("supports URL and Request inputs, input headers, and successful explicit filters", async () => {
    const captureRequest = vi.fn();
    const originalFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const instrumented = createInstrumentedFetch(originalFetch as typeof fetch, { captureRequest }, {
      tracePropagationTargets: ["https://api.example.com"],
      networkFilter: { statusCodes: [204] },
      headerAllowlist: ["x-debugbundle-trace-id", "x-request-id"]
    });

    await instrumented(new URL("https://api.example.com/health"), {
      headers: { "x-request-id": "req-1" }
    });
    const request = new Request("https://api.example.com/orders", {
      method: "patch",
      headers: { "X-DebugBundle-Trace-Id": "from-request" }
    });
    await instrumented(request);

    expect(captureRequest).toHaveBeenCalledTimes(2);
    expect(captureRequest.mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      url: "https://api.example.com/health",
      headers: {
        "x-request-id": "req-1",
        "x-debugbundle-trace-id": expect.any(String)
      }
    });
    expect(captureRequest.mock.calls[1]?.[0]).toMatchObject({
      method: "PATCH",
      traceId: "from-request"
    });
  });

  it("applies capture disablement, allow, deny, status, and duration filters", async () => {
    const captureRequest = vi.fn();
    const originalFetch = vi.fn(async () => new Response("", { status: 201 }));

    const cases = [
      { captureNetwork: false },
      { networkFilter: { urlDenylist: ["orders"] } },
      { networkFilter: { urlAllowlist: ["checkout"] } },
      { networkFilter: { statusCodes: [500] } },
      { networkFilter: { minResponseTime: Number.MAX_SAFE_INTEGER } }
    ];
    for (const options of cases) {
      await createInstrumentedFetch(originalFetch as typeof fetch, { captureRequest }, options)(
        "https://api.example.com/orders"
      );
    }
    expect(captureRequest).not.toHaveBeenCalled();

    await createInstrumentedFetch(originalFetch as typeof fetch, { captureRequest }, {
      networkFilter: { urlAllowlist: ["orders"], minResponseTime: 0 }
    })("https://api.example.com/orders");
    expect(captureRequest).toHaveBeenCalledOnce();
  });

  it("installs and restores global fetch instrumentation idempotently", async () => {
    const captureRequest = vi.fn();
    const originalFetch = vi.fn(async () => new Response("", { status: 500 }));
    vi.stubGlobal("fetch", originalFetch);
    vi.stubGlobal("XMLHttpRequest", undefined);

    const restore = instrumentDebugBundleNetwork({
      client: { captureRequest } as unknown as DebugBundleClient
    });
    const instrumentedFetch = globalThis.fetch;
    const secondRestore = instrumentDebugBundleNetwork({
      client: { captureRequest } as unknown as DebugBundleClient
    });
    await globalThis.fetch("/global");
    secondRestore();
    restore();

    expect(instrumentedFetch).not.toBe(originalFetch);
    expect(globalThis.fetch).not.toBe(instrumentedFetch);
    await globalThis.fetch("/restored");
    expect(originalFetch).toHaveBeenCalledTimes(2);
    expect(captureRequest).toHaveBeenCalledOnce();
  });

  it("instruments XMLHttpRequest load completion and restores its prototype", () => {
    class FakeXMLHttpRequest {
      status = 503;
      headers: Record<string, string> = {};
      private listeners = new Map<string, () => void>();

      open(_method: string, _url: string | URL): void {
        return undefined;
      }

      send(): void {
        this.listeners.get("loadend")?.();
      }

      setRequestHeader(name: string, value: string): void {
        this.headers[name] = value;
      }

      addEventListener(type: string, listener: () => void): void {
        this.listeners.set(type, listener);
      }
    }
    const originalOpen = FakeXMLHttpRequest.prototype.open;
    const originalSend = FakeXMLHttpRequest.prototype.send;
    const captureRequest = vi.fn();
    vi.stubGlobal("fetch", undefined);
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);

    const restore = instrumentDebugBundleNetwork({
      client: { captureRequest } as unknown as DebugBundleClient
    });
    const request = new FakeXMLHttpRequest();
    request.open("POST", "/orders");
    request.send();

    expect(request.headers["X-DebugBundle-Trace-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(captureRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        url: "/orders",
        traceId: request.headers["X-DebugBundle-Trace-Id"]
      }),
      expect.objectContaining({ statusCode: 503 }),
      { trace_id: request.headers["X-DebugBundle-Trace-Id"] }
    );
    restore();
    expect(FakeXMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(FakeXMLHttpRequest.prototype.send).toBe(originalSend);
  });

  it("supports XHR requests without trace injection", () => {
    class FakeXMLHttpRequest {
      status = 200;
      listener: (() => void) | undefined;
      setRequestHeader = vi.fn();
      open(): void {
        return undefined;
      }
      send(): void {
        this.listener?.();
      }
      addEventListener(_type: string, listener: () => void): void {
        this.listener = listener;
      }
    }
    const captureRequest = vi.fn();
    vi.stubGlobal("fetch", undefined);
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);

    const restore = instrumentDebugBundleNetwork({
      client: { captureRequest } as unknown as DebugBundleClient,
      tracePropagationTargets: ["https://api.example.com"]
    });
    const request = new FakeXMLHttpRequest();
    request.open();
    request.send();

    expect(request.setRequestHeader).not.toHaveBeenCalled();
    expect(captureRequest).not.toHaveBeenCalled();
    restore();
  });
});
