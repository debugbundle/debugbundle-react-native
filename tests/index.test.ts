import { afterEach, describe, expect, it } from "vitest";
import {
  captureDebugBundleConsole,
  DebugBundle,
  installDebugBundleErrorHandlers
} from "../src/index.js";
import { installRecordingNativeModule, resetDebugBundleNativeModule } from "../src/testing.js";

describe("singleton facade", () => {
  afterEach(() => {
    resetDebugBundleNativeModule();
  });

  it("delegates the complete public capture surface to the singleton client", async () => {
    const nativeModule = installRecordingNativeModule();
    DebugBundle.init({
      projectToken: "dbp_singleton_test",
      captureErrors: true,
      captureUnhandledRejections: false,
      captureConsole: false
    });
    const restoreErrors = installDebugBundleErrorHandlers(DebugBundle);

    DebugBundle.setContext("release_stage", "test");
    DebugBundle.captureException(new Error("exception"), { trace_id: "trace-exception" });
    DebugBundle.captureError(new TypeError("error"));
    DebugBundle.captureLog("warning", "warning");
    DebugBundle.captureRequest(
      { method: "POST", url: "/orders" },
      { statusCode: 503, durationMillis: 12 }
    );
    DebugBundle.captureMessage("message");
    DebugBundle.probe("cart.state", { items: 2 });
    DebugBundle.recordBreadcrumb("manual", { step: 1 });
    DebugBundle.recordScreen("Checkout", null, "manual");
    expect(await DebugBundle.activateProbeTriggerToken("probe-token")).toBe(true);
    await DebugBundle.flush();

    expect(DebugBundle.status).toBe("healthy");
    expect(DebugBundle.lastEventAt).not.toBeNull();
    expect(nativeModule.events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining([
        "frontend_exception",
        "log_event",
        "request_event",
        "frontend_breadcrumb"
      ])
    );
    expect(nativeModule.probes).toHaveLength(1);
    restoreErrors();

    DebugBundle.init({
      projectToken: "dbp_singleton_without_handlers",
      captureErrors: false,
      captureConsole: false
    });
  });

  it("installs optional error and console capture from facade configuration", () => {
    installRecordingNativeModule();
    DebugBundle.init({
      projectToken: "dbp_singleton_handlers",
      captureErrors: true,
      captureUnhandledRejections: false,
      captureConsole: true
    });

    const restoreErrors = installDebugBundleErrorHandlers(DebugBundle);
    const restoreConsole = captureDebugBundleConsole(DebugBundle);
    restoreConsole();
    restoreErrors();

    expect(DebugBundle.status).toBe("healthy");
  });
});
