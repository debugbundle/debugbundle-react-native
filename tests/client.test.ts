import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebugBundleClient, resolveConfig } from "../src/client.js";
import { installRecordingNativeModule, resetDebugBundleNativeModule } from "../src/testing.js";

describe("React Native client", () => {
  afterEach(() => {
    resetDebugBundleNativeModule();
  });

  it("exposes the universal SDK methods", () => {
    const client = createDebugBundleClient();
    for (const method of [
      "init",
      "captureException",
      "captureError",
      "captureLog",
      "captureRequest",
      "captureMessage",
      "setContext",
      "flush",
      "probe"
    ]) {
      expect(typeof client[method as keyof typeof client]).toBe("function");
    }
  });

  it("degrades safely when the native module is unavailable", () => {
    resetDebugBundleNativeModule();
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });
    client.captureException(new Error("boom"));
    expect(client.status).toBe("degraded");
  });

  it("forwards scalar context through the additive object-safe native bridge", () => {
    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });

    client.setContext("release_stage", "smoke");
    client.captureException(new Error("boom"));

    expect(nativeModule.context).toEqual({ release_stage: "smoke" });
    expect(nativeModule.events[0]?.context).toMatchObject({ release_stage: "smoke" });
  });

  it("retains the legacy setContext bridge fallback for installed native binaries", () => {
    const nativeModule = installRecordingNativeModule();
    nativeModule.setContextValue = undefined;
    let received: unknown;
    nativeModule.setContext = (_key, value) => {
      received = value;
    };
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });

    client.setContext("release_stage", "legacy");

    expect(received).toBe("legacy");
  });

  it("authors a canonical React Native exception without losing JS error identity", () => {
    const nativeModule = installRecordingNativeModule(undefined);
    nativeModule.initialize = function initialize(config) {
      this.config = config;
      return {
        status: "healthy",
        lastEventAt: null,
        device: { device_type: "mobile" }
      };
    };
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });

    client.captureException(new Error("boom"), {
      user_password: "secret",
      nested: { accessToken: "token" }
    });

    expect(nativeModule.events).toHaveLength(1);
    expect(nativeModule.events[0]?.sdk_name).toBe("@debugbundle/sdk-react-native");
    expect(nativeModule.events[0]?.schema_version).toBe("2026-03-01");
    expect(nativeModule.events[0]).not.toHaveProperty("device");
    expect(nativeModule.events[0]?.payload).toMatchObject({
      name: "Error",
      message: "boom"
    });
    expect(nativeModule.events[0]?.payload.stack).toContain("boom");
    expect(nativeModule.events[0]?.context).toMatchObject({
      user_password: "[Redacted]",
      nested: { accessToken: "[Redacted]" }
    });
    expect(nativeModule.events[0]?.payload.device).toMatchObject({
      device_type: "mobile"
    });
  });

  it("keeps heavy probe callbacks dormant without remote activation support", () => {
    installRecordingNativeModule();
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });
    let invoked = false;

    client.probe("checkout.heavy", () => {
      invoked = true;
      return { state: "expensive" };
    }, { heavy: true });
    client.captureException(new Error("boom"));

    expect(invoked).toBe(false);
  });

  it("allows heavy JS probes after a native trigger token activation", async () => {
    installRecordingNativeModule();
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });
    let invoked = false;

    expect(await client.activateProbeTriggerToken("dbundle_probe_test")).toBe(true);
    client.probe("checkout.heavy", () => {
      invoked = true;
      return { state: "expensive" };
    }, { heavy: true });
    client.captureException(new Error("boom"));

    expect(invoked).toBe(true);
  });

  it("composes JS probes with native remote activation and object-wraps list data", () => {
    const nativeModule = installRecordingNativeModule();
    nativeModule.activeProbeLabels.add("checkout.remote");
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });
    let invoked = false;

    client.probe("checkout.remote", () => {
      invoked = true;
      return ["cart", 42];
    }, { heavy: true });

    expect(invoked).toBe(true);
    expect(nativeModule.probes).toHaveLength(1);
    expect(nativeModule.probes[0]?.data).toEqual({ value: ["cart", 42] });
  });

  it("passes successful request observations to native policy instead of hard-coded JS filtering", () => {
    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });
    client.setContext("release_stage", "smoke");

    client.captureRequest(
      { method: "GET", url: "https://shop.example/checkout?cart=42" },
      { statusCode: 200, durationMillis: 25 },
      { trace_id: "trace-rn", password: "secret" }
    );

    const request = nativeModule.events.find((event) => event.event_type === "request_event");
    expect(request?.payload).toMatchObject({
      method: "GET",
      path: "/checkout",
      query: { cart: "42" },
      response_status: 200,
      duration_ms: 25
    });
    expect(request?.correlation).toEqual({ trace_id: "trace-rn" });
    expect(request?.context).toEqual({
      release_stage: "smoke",
      trace_id: "[Redacted]",
      password: "[Redacted]"
    });
  });

  it("delegates sampling and session caps once to the native capture policy", () => {
    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({
      projectToken: "dbp_test",
      sampleRate: 0,
      sessionSampleRate: 0,
      maxEventsPerSession: 1
    });

    client.captureLog("one", "warning");
    client.captureLog("two", "warning");

    expect(nativeModule.events).toHaveLength(2);
    expect(nativeModule.config).toMatchObject({
      sampleRate: 0,
      sessionSampleRate: 0,
      maxEventsPerSession: 1
    });
  });

  it("honors the local error capture switch before crossing the native boundary", () => {
    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({
      projectToken: "dbp_test",
      captureErrors: false
    });

    client.captureException(new Error("disabled"));

    expect(nativeModule.events).toHaveLength(0);
  });

  it("retains the translation bridge fallback for older installed native binaries", () => {
    const nativeModule = installRecordingNativeModule();
    nativeModule.enqueueCanonicalEvent = undefined;
    const client = createDebugBundleClient({ projectToken: "dbp_test" });

    client.captureException(new TypeError("legacy"));

    expect(nativeModule.events[0]?.payload.error).toMatchObject({
      name: "TypeError",
      message: "legacy"
    });
  });

  it("runs beforeSend after redaction and before local capture policy", () => {
    const nativeModule = installRecordingNativeModule();
    let observedPassword: unknown;
    const client = createDebugBundleClient({
      projectToken: "dbp_test",
      captureLogs: false,
      beforeSend(event) {
        observedPassword = (event.payload.attributes as Record<string, unknown>).password;
        return {
          ...event,
          payload: { ...event.payload, marker: "hooked" }
        };
      }
    });

    client.captureLog("disabled", "error", { password: "secret" });

    expect(observedPassword).toBe("[Redacted]");
    expect(nativeModule.events).toHaveLength(0);
    expect(nativeModule.config).not.toHaveProperty("beforeSend");
  });

  it("lets beforeSend mutate or drop events without leaking failures or invalid output", () => {
    const nativeModule = installRecordingNativeModule();
    const mutated = createDebugBundleClient({
      projectToken: "dbp_test",
      beforeSend(event) {
        return { ...event, context: { hook: "kept" } };
      }
    });
    mutated.captureException(new Error("mutated"));

    const dropped = createDebugBundleClient({
      projectToken: "dbp_test",
      beforeSend: () => null
    });
    dropped.captureException(new Error("dropped"));

    const invalid = createDebugBundleClient({
      projectToken: "dbp_test",
      beforeSend(event) {
        return { ...event, event_id: "invalid" };
      }
    });
    invalid.captureException(new Error("original"));

    const failed = createDebugBundleClient({
      projectToken: "dbp_test",
      beforeSend() {
        throw new Error("hook failed");
      }
    });
    failed.captureException(new Error("fallback"));

    expect(nativeModule.events).toHaveLength(3);
    expect(nativeModule.events[0]?.context).toEqual({ hook: "kept" });
    expect(nativeModule.events[1]?.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(nativeModule.events[2]?.payload.message).toBe("fallback");
  });

  it("reports disabled, incomplete, failed, and asynchronous initialization safely", async () => {
    const disabledModule = installRecordingNativeModule();
    const disabled = createDebugBundleClient({ projectToken: "dbp_test", enabled: false });
    expect(disabled.status).toBe("disconnected");
    expect(disabled.lastEventAt).toBeNull();
    expect(disabledModule.config).toBeNull();

    const incomplete = createDebugBundleClient({ projectToken: "dbp_test", endpoint: "" });
    expect(incomplete.status).toBe("degraded");

    const throwingModule = installRecordingNativeModule();
    throwingModule.initialize = () => {
      throw new Error("native init failed");
    };
    expect(createDebugBundleClient({ projectToken: "dbp_test" }).status).toBe("degraded");

    const asyncModule = installRecordingNativeModule();
    asyncModule.initialize = async () => ({
      status: "disconnected",
      lastEventAt: 42,
      nativeModuleAvailable: false
    });
    const asynchronous = createDebugBundleClient({ projectToken: "dbp_test" });
    expect(asynchronous.status).toBe("healthy");
    await Promise.resolve();
    await Promise.resolve();
    expect(asynchronous.status).toBe("disconnected");
    expect(asynchronous.lastEventAt).toBe(42);
  });

  it("normalizes native state defaults and configuration bounds before delegation", () => {
    const nativeModule = installRecordingNativeModule();
    nativeModule.initialize = function initialize(config) {
      this.config = config;
      return {
        status: "" as "healthy",
        lastEventAt: null
      };
    };

    const client = createDebugBundleClient({
      projectToken: "dbp_test",
      batchSize: 1000,
      flushInterval: 1,
      sampleRate: -1,
      sessionSampleRate: 2,
      maxEventsPerSession: Number.NaN,
      offlineQueueMaxBytes: Number.POSITIVE_INFINITY,
      maxProbeEntriesPerLabel: 0,
      beforeSend: (event) => event
    });

    expect(client.status).toBe("healthy");
    expect(nativeModule.config).toMatchObject({
      batchSize: 100,
      flushInterval: 100,
      sampleRate: 0,
      sessionSampleRate: 1,
      maxEventsPerSession: 100,
      offlineQueueMaxBytes: 5 * 1024 * 1024,
      maxProbeEntriesPerLabel: 1
    });
    expect(nativeModule.config).not.toHaveProperty("beforeSend");

    const defaults = resolveConfig({});
    expect(defaults.projectToken).toBe("");
    expect(defaults.service).toBe("react-native-app");
    expect(defaults.redactFields).toContain("password");
    expect(defaults.headerAllowlist).toContain("content-type");
  });

  it("flushes and refreshes native status while swallowing transport failures", async () => {
    const disconnected = createDebugBundleClient();
    await expect(disconnected.flush()).resolves.toBeUndefined();

    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({ projectToken: "dbp_test" });
    await client.flush();
    expect(client.status).toBe("healthy");

    nativeModule.flush = () => {
      throw new Error("flush failed");
    };
    await expect(client.flush()).resolves.toBeUndefined();
    expect(client.status).toBe("healthy");

    nativeModule.setContext?.("legacy", "value");
  });

  it("handles unavailable, false, and failed trigger-token activation", async () => {
    const nativeModule = installRecordingNativeModule();
    nativeModule.activateProbeTriggerToken = undefined;
    const unavailable = createDebugBundleClient({ projectToken: "dbp_test" });
    expect(await unavailable.activateProbeTriggerToken("token")).toBe(false);

    nativeModule.activateProbeTriggerToken = () => false;
    expect(await unavailable.activateProbeTriggerToken("token")).toBe(false);

    nativeModule.activateProbeTriggerToken = () => {
      throw new Error("invalid token");
    };
    expect(await unavailable.activateProbeTriggerToken("token")).toBe(false);
  });

  it("bounds probe buffers, captures callback failures, and can omit buffered probes from errors", () => {
    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({
      projectToken: "dbp_test",
      maxProbeLabels: 1,
      maxProbeEntriesPerLabel: 1,
      probeFlushOnError: false
    });

    client.probe("", { ignored: true });
    client.probe("first", () => {
      throw new Error("probe failed");
    });
    client.probe("second", { ignored: true });
    client.captureError({ message: "plain error" });

    expect(nativeModule.probes).toHaveLength(1);
    expect(nativeModule.probes[0]?.data).toMatchObject({
      error: expect.objectContaining({ message: "probe failed" })
    });
    expect(nativeModule.events.at(-1)?.payload).toMatchObject({
      name: "Error",
      message: "plain error",
      stack: "Error: plain error",
      probe_data: { version: 1, items: [] }
    });
  });

  it("captures messages, sanitizes screens, and honors screen capture disablement", () => {
    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({
      projectToken: "dbp_test",
      maxBreadcrumbs: 1
    });

    client.captureMessage("step", "info", { password: "secret" });
    client.recordScreen(`Checkout ${"x".repeat(140)}`, "Cart Home", "manual");
    const lastBreadcrumb = nativeModule.events.at(-1);
    expect(lastBreadcrumb?.payload.data).toMatchObject({
      screen_name: expect.stringMatching(/^Checkout_/),
      previous_screen: "Cart_Home",
      source: "manual"
    });
    expect((lastBreadcrumb?.payload.data as { screen_name: string }).screen_name).toHaveLength(120);

    const disabled = createDebugBundleClient({
      projectToken: "dbp_test",
      captureScreens: false
    });
    const before = nativeModule.events.length;
    disabled.recordScreen("Ignored");
    expect(nativeModule.events).toHaveLength(before);
  });

  it("normalizes repeated and malformed request query strings without throwing", () => {
    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({ projectToken: "dbp_test" });

    client.captureRequest(
      { method: "GET", url: "https://example.test/?item=one&item=two&item=three" },
      { statusCode: 500 }
    );
    client.captureRequest(
      { method: "GET", url: "/search?q=hello+world&q=again&bad=%E0%A4%A&empty" },
      { statusCode: 500 }
    );

    const requests = nativeModule.events.filter((candidate) => candidate.event_type === "request_event");
    expect(requests[0]?.payload.query).toEqual({ item: ["one", "two", "three"] });
    expect(requests[1]?.payload).toMatchObject({
      path: "/search",
      query: {
        q: ["hello world", "again"],
        bad: "%E0%A4%A",
        empty: ""
      },
      duration_ms: 0,
      route_template: null
    });
  });

  it("uses the UUID fallback and canonicalizes complete and invalid native device data", () => {
    vi.stubGlobal("crypto", {});
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const nativeModule = installRecordingNativeModule();
    nativeModule.initialize = function initialize(config) {
      this.config = config;
      return {
        status: "healthy",
        device: {
          user_agent: "DebugBundle Test",
          os_name: "iOS",
          os_version: "19",
          device_type: "watch",
          screen_width: 390.9,
          screen_height: -1,
          viewport: { width: 380, height: 800 },
          device_pixel_ratio: 0,
          touch_capable: true,
          locale: "en-MT",
          connection_type: "wifi",
          color_scheme_preference: "dark",
          api_level: -1,
          manufacturer: "Apple",
          model: "Simulator",
          timezone: "Europe/Malta",
          battery_level: -0.1,
          charging: true,
          free_disk_bytes: 100.8,
          free_memory_bytes: Number.NaN,
          rooted: false
        }
      };
    };
    const client = createDebugBundleClient({
      projectToken: "dbp_test",
      appVersion: "1.0",
      buildNumber: "42",
      releaseChannel: "beta"
    });

    client.captureLog("device", "warning");

    expect(nativeModule.events[0]?.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(nativeModule.events[0]?.payload.device).toMatchObject({
      os: { name: "iOS", version: "19" },
      device_type: "unknown",
      screen: { width: 390, height: 0 },
      viewport: { width: 380, height: 800 },
      device_pixel_ratio: null,
      touch_capable: true,
      language: "en-MT",
      color_scheme_preference: "dark",
      app_version: "1.0",
      build_number: "42",
      release_channel: "beta",
      api_level: null,
      battery_level: null,
      battery_charging: true,
      free_disk_bytes: 100,
      free_memory_bytes: null,
      jailbroken: false
    });
    vi.unstubAllGlobals();
  });

  it("adds legacy request URL context for pre-canonical native binaries", () => {
    const nativeModule = installRecordingNativeModule();
    nativeModule.enqueueCanonicalEvent = undefined;
    const client = createDebugBundleClient({ projectToken: "dbp_test" });

    client.captureRequest(
      { method: "GET", url: "https://example.test/legacy" },
      { statusCode: 500 }
    );

    const request = nativeModule.events.find((candidate) => candidate.event_type === "request_event");
    expect(request?.payload.url).toBe("/legacy");
  });
});
