import { describe, expect, it, vi } from "vitest";
import { createInstrumentedFetch, shouldInjectTrace } from "../src/network.js";
import type { DebugBundleClient } from "../src/types.js";

describe("network instrumentation", () => {
  it("injects trace IDs only into relative or configured first-party targets", () => {
    expect(shouldInjectTrace("/checkout", [])).toBe(true);
    expect(shouldInjectTrace("https://api.example.com/v1/orders", ["https://api.example.com"])).toBe(true);
    expect(shouldInjectTrace("https://third-party.example/pay", ["https://api.example.com"])).toBe(false);
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
});
