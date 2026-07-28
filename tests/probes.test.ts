import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugBundle } from "../src/index.js";
import { activateDebugBundleProbeTrigger, probe } from "../src/probes.js";
import { installRecordingNativeModule, resetDebugBundleNativeModule } from "../src/testing.js";
import type { DebugBundleClient } from "../src/types.js";

describe("probe facade helpers", () => {
  afterEach(() => {
    resetDebugBundleNativeModule();
  });

  it("forwards probe data through the singleton facade", () => {
    const nativeModule = installRecordingNativeModule();
    DebugBundle.init({ projectToken: "dbp_probe_test" });

    probe("checkout.state", { stage: "payment" });

    expect(nativeModule.probes[0]).toMatchObject({
      label: "checkout.state",
      data: { stage: "payment" }
    });
  });

  it("starts asynchronous native activation and reports only non-empty tokens", () => {
    const activateProbeTriggerToken = vi.fn(async () => true);
    const client = { activateProbeTriggerToken } as unknown as DebugBundleClient;

    expect(activateDebugBundleProbeTrigger("token", client)).toBe(true);
    expect(activateDebugBundleProbeTrigger("", client)).toBe(false);
    expect(activateProbeTriggerToken).toHaveBeenNthCalledWith(1, "token");
    expect(activateProbeTriggerToken).toHaveBeenNthCalledWith(2, "");
  });
});
