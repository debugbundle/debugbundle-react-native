import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebugBundleClient, resolveConfig } from "../src/client.js";
import { installRecordingNativeModule, resetDebugBundleNativeModule } from "../src/testing.js";

describe("React Native client", () => {
  afterEach(() => {
    resetDebugBundleNativeModule();
  });

  it("defers hooks after capture and reserves bounded privacy-safe work before callbacks", async () => {
    const nativeModule = installRecordingNativeModule();
    const beforeSend = vi.fn(event => event);
    const client = createDebugBundleClient({ projectToken: "dbp_test", beforeSend });
    client.captureLog("first", "error", { password: "must-not-retain" });
    expect(beforeSend).not.toHaveBeenCalled();
    for (let i = 0; i < 10_000; i++) client.captureLog(`burst-${i}`, "error");
    expect(beforeSend).not.toHaveBeenCalled();
    const state = client as unknown as { pendingNativeCalls: number; pendingNativeBytes: number };
    expect(state.pendingNativeCalls).toBeLessThanOrEqual(256);
    expect(state.pendingNativeBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    await client.flush();
    expect(beforeSend.mock.calls.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(nativeModule.events)).not.toContain("must-not-retain");
  });

  it("charges valid hook expansion while a native bridge is held and rechecks final levels", async () => {
    const nativeModule = installRecordingNativeModule();
    const accepted: string[] = [];
    const held = new Promise<boolean>(() => undefined);
    nativeModule.enqueueCanonicalEvent = event => { accepted.push(JSON.stringify(event)); return held; };
    const observed: number[] = [];
    const client = createDebugBundleClient({ projectToken: "dbp_test", beforeSend: event => {
      observed.push((client as unknown as { pendingNativeBytes: number }).pendingNativeBytes);
      return { ...event, payload: { ...event.payload, message: "app-redacted",
        attributes: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`field_${i}`, "x".repeat(4000)])) } };
    } });
    for (let i = 0; i < 256; i++) client.captureLog(`original-${i}`, "error");
    await Promise.resolve();
    expect(accepted.length).toBeGreaterThan(0);
    expect(accepted.length).toBeLessThan(256);
    expect(observed.every(bytes => bytes <= 4 * 1024 * 1024)).toBe(true);
    expect(accepted.join()).not.toContain('"message":"original-');
    const demoted = createDebugBundleClient({ projectToken: "dbp_test", beforeSend: event =>
      ({ ...event, payload: { ...event.payload, level: "info" } }) });
    const before = accepted.length;
    demoted.captureLog("filtered replacement", "error");
    await Promise.resolve();
    expect(accepted).toHaveLength(before);
  });

  it("contains accidentally async hook rejection and preserves its protected original", async () => {
    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({ projectToken: "dbp_test",
      beforeSend: (() => Promise.reject(new Error("invalid async hook"))) as never });
    client.captureLog("original", "error");
    await client.flush();
    expect(nativeModule.events[0]?.payload.message).toBe("original");
  });

  it("measures the actual expanded legacy bridge representation before retaining it", async () => {
    const nativeModule = installRecordingNativeModule();
    nativeModule.enqueueCanonicalEvent = undefined;
    const sizes: number[] = [];
    const held = new Promise<void>(() => undefined);
    nativeModule.enqueueEvent = event => { sizes.push(Buffer.byteLength(JSON.stringify(event))); return held; };
    const client = createDebugBundleClient({ projectToken: "dbp_test" });
    const tooLarge = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, "x".repeat(1800)]));
    client.captureException(new Error("oversized legacy"), tooLarge);
    await Promise.resolve();
    expect(sizes).toEqual([]);
    const context = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`field_${i}`, "x".repeat(1800)]));
    for (let i = 0; i < 256; i++) client.captureException(new Error(`legacy-${i}`), context);
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every(bytes => bytes <= 64 * 1024)).toBe(true);
    const retained = (client as unknown as { pendingNativeBytes: number }).pendingNativeBytes;
    expect(retained).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(retained).toBeGreaterThanOrEqual(sizes.reduce((total, size) => total + size, 0));
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
      user_password: "[REDACTED]",
      nested: { accessToken: "[REDACTED]" }
    });
    expect(nativeModule.events[0]?.payload.device).toMatchObject({
      device_type: "mobile"
    });
  });

  it("withholds hook-injected credentials in protocol metadata before either native bridge", async () => {
    for (const useLegacy of [false, true]) {
      const nativeModule = installRecordingNativeModule();
      if (useLegacy) nativeModule.enqueueCanonicalEvent = undefined;
      const client = createDebugBundleClient({
        projectToken: "dbp_test", service: "rn",
        beforeSend: (event) => ({ ...event, sdk_version: "dbundle_proj_SYNTHETIC_SECRET" })
      });
      client.captureException(new Error("boom"));
      await client.flush();
      expect(nativeModule.events).toEqual([]);
    }
  });

  it("scrubs hook-injected content before both native bridge variants", async () => {
    for (const useLegacy of [false, true]) {
      const nativeModule = installRecordingNativeModule();
      if (useLegacy) nativeModule.enqueueCanonicalEvent = undefined;
      const client = createDebugBundleClient({
        projectToken: "dbp_test", service: "rn",
        beforeSend: (event) => {
          event.payload.message = "Authorization: Bearer abcdef123456";
          event.context = { refreshToken: "canary-private-value", operation: "checkout" };
          return event;
        }
      });

      client.captureException(new Error("boom"));
      await client.flush();

      const outbound = JSON.stringify(nativeModule.events);
      expect(outbound).not.toContain("canary-private-value");
      expect(outbound).not.toContain("abcdef123456");
      expect(outbound).toContain("checkout");
      expect(nativeModule.events[0]?.payload.message).toBe("Authorization: [REDACTED]");
    }
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
      trace_id: "trace-rn",
      password: "[REDACTED]"
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

  it("bounds pending native bridge calls and reserves capacity for exceptions", () => {
    const nativeModule = installRecordingNativeModule();
    const accepted: string[] = [];
    nativeModule.enqueueCanonicalEvent = (event) => {
      accepted.push(event.event_type);
      return new Promise<boolean>(() => {});
    };
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });

    for (let index = 0; index < 1_000; index += 1) client.captureLog(`warning ${index}`, "warning");
    for (let index = 0; index < 40; index += 1) client.captureException(new Error(`failure ${index}`));

    expect(accepted.filter((type) => type === "log_event")).toHaveLength(224);
    expect(accepted.filter((type) => type === "frontend_exception")).toHaveLength(32);
  });

  it("contains throwing capture context accessors", () => {
    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({ projectToken: "dbp_test" });
    const context = Object.defineProperty({}, "trace_id", {
      enumerable: true, get() { throw new Error("hostile context"); }
    });
    expect(() => client.captureLog("failure", "error", context)).not.toThrow();
    expect(() => client.captureException(new Error("failure"), context)).not.toThrow();
    expect(() => client.captureRequest({ method: "GET", url: "https://example.test" }, { statusCode: 500 }, context)).not.toThrow();
    expect(() => client.captureMessage("message", "warning", context)).not.toThrow();
    expect(nativeModule.events.length).toBeGreaterThan(0);
  });

  it("shares bridge admission with probes and context and releases settled auxiliary calls", async () => {
    const nativeModule = installRecordingNativeModule();
    let release!: (value: boolean) => void;
    const held = new Promise<boolean>(resolve => { release = resolve; });
    const probes = vi.fn(() => held);
    const contexts = vi.fn(() => held.then(() => undefined));
    nativeModule.captureProbe = probes;
    nativeModule.setContextValue = contexts;
    const client = createDebugBundleClient({ projectToken: "dbp_test" });
    const supplier = vi.fn(() => ({ value: 1 }));
    for (let index = 0; index < 112; index++) client.probe("sample", supplier);
    for (let index = 0; index < 1000; index++) client.setContext("stage", "active");
    for (let index = 0; index < 1000; index++) client.probe("sample", supplier);
    expect(probes).toHaveBeenCalledTimes(112);
    expect(contexts).toHaveBeenCalledTimes(112);
    expect(supplier).toHaveBeenCalledTimes(112);
    client.captureException(new Error("priority remains available"));
    expect(nativeModule.events).toHaveLength(1);
    release(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    client.probe("sample", supplier);
    expect(probes).toHaveBeenCalledTimes(113);
  });

  it("bounds auxiliary bridge bytes and protects local context before handoff", () => {
    const nativeModule = installRecordingNativeModule();
    let bytes = 0;
    nativeModule.captureProbe = (label, data, occurredAt) => {
      bytes += new TextEncoder().encode(JSON.stringify({ label, data, occurredAt })).byteLength;
      return new Promise<boolean>(() => {});
    };
    const client = createDebugBundleClient({ projectToken: "dbp_test" });
    client.setContext("password", "private-value");
    expect(nativeModule.context.password).toBe("[REDACTED]");
    const large = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field_${index}`, "x".repeat(1500)]));
    for (let index = 0; index < 300; index++) client.probe("sample", large);
    expect(bytes).toBeGreaterThan(1024 * 1024);
    expect(bytes).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(() => client.probe("sample", {}, { get heavy() { throw new Error("host option"); } })).not.toThrow();
  });

  it("bounds context keys and isolates auxiliary native failures", () => {
    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({ projectToken: "dbp_test" });
    for (let index = 0; index < 1000; index++) client.setContext(`field_${index}`, index);
    client.setContext("x".repeat(129), "oversized key");
    expect(Object.keys(nativeModule.context)).toHaveLength(50);
    nativeModule.isProbeActive = () => { throw new Error("native probe reader"); };
    expect(() => client.probe("sample", {})).not.toThrow();
    nativeModule.isProbeActive = () => false;
    expect(() => client.probe("sample", {}, { get heavy() { throw new Error("host option"); } })).not.toThrow();
    nativeModule.setContextValue = () => { throw new Error("native context writer"); };
    expect(() => client.setContext("field_0", 2)).not.toThrow();
  });

  it("reopens bridge capacity after native acknowledgements settle", async () => {
    const nativeModule = installRecordingNativeModule();
    let release: ((value: boolean) => void) | undefined;
    const pending = new Promise<boolean>((resolve) => { release = resolve; });
    const accepted: string[] = [];
    nativeModule.enqueueCanonicalEvent = (event) => {
      accepted.push(event.event_id);
      return pending;
    };
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });

    for (let index = 0; index < 225; index += 1) client.captureLog(`warning ${index}`, "warning");
    expect(accepted).toHaveLength(224);
    release?.(true);
    await vi.waitFor(() => expect((client as unknown as { pendingNativeCalls: number }).pendingNativeCalls).toBe(0));
    client.captureLog("after acknowledgement", "warning");
    expect(accepted).toHaveLength(225);
  });

  it("bounds retained native bridge payload bytes as well as call count", () => {
    const nativeModule = installRecordingNativeModule();
    let acceptedBytes = 0;
    let acceptedExceptions = 0;
    nativeModule.enqueueCanonicalEvent = (event) => {
      acceptedBytes += new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (event.event_type === "frontend_exception") acceptedExceptions += 1;
      return new Promise<boolean>(() => {});
    };
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });
    const context = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field_${index}`, "x".repeat(1_500)]));

    for (let index = 0; index < 224; index += 1) client.captureLog(`warning ${index}`, "warning", context);
    client.captureException(new Error("priority after low-priority byte pressure"));

    expect(acceptedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(acceptedExceptions).toBe(1);
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

  it("rejects locally disabled requests before reading application request metadata", () => {
    const nativeModule = installRecordingNativeModule();
    const getHeaders = vi.fn(() => ({ authorization: "secret" }));
    const client = createDebugBundleClient({ projectToken: "dbp_test", captureNetwork: false });

    client.captureRequest({ method: "GET", url: "/disabled", get headers() { return getHeaders(); } },
      { statusCode: 200 });

    expect(getHeaders).not.toHaveBeenCalled();
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

  it("filters disabled logs before context access and beforeSend while protecting eligible logs", async () => {
    const nativeModule = installRecordingNativeModule();
    let observedPassword: unknown;
    let contextReads = 0;
    let hookCalls = 0;
    const client = createDebugBundleClient({
      projectToken: "dbp_test",
      logLevel: "warning",
      beforeSend(event) {
        hookCalls += 1;
        observedPassword = (event.payload.attributes as Record<string, unknown>).password;
        return {
          ...event,
          payload: { ...event.payload, marker: "hooked" }
        };
      }
    });

    const context = { get password() { contextReads += 1; return "secret"; } };
    for (let index = 0; index < 10_000; index += 1) {
      client.captureLog("disabled", "info", context);
    }
    expect(contextReads).toBe(0);
    expect(hookCalls).toBe(0);
    client.captureLog("eligible", "error", context);
    expect(hookCalls).toBe(0);
    await client.flush();

    expect(observedPassword).toBe("[REDACTED]");
    expect(hookCalls).toBe(1);
    expect(nativeModule.events).toHaveLength(1);
    expect(nativeModule.config).not.toHaveProperty("beforeSend");
  });

  it("lets beforeSend mutate or drop events without leaking failures or invalid output", async () => {
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
    await failed.flush();

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
