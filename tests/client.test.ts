import { afterEach, describe, expect, it } from "vitest";
import { createDebugBundleClient } from "../src/client.js";
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

  it("redacts JS-originated exception context before native enqueue", () => {
    const nativeModule = installRecordingNativeModule();
    const client = createDebugBundleClient({ projectToken: "dbp_test", service: "rn" });

    client.captureException(new Error("boom"), {
      user_password: "secret",
      nested: { accessToken: "token" }
    });

    expect(nativeModule.events).toHaveLength(1);
    expect(nativeModule.events[0]?.sdk_name).toBe("@debugbundle/sdk-react-native");
    expect(nativeModule.events[0]?.payload.context).toMatchObject({
      user_password: "[Redacted]",
      nested: { accessToken: "[Redacted]" }
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
});
