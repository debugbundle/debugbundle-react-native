import { afterEach, describe, expect, it } from "vitest";
import { getNativeModule } from "../src/native.js";
import {
  createRecordingNativeModule,
  installRecordingNativeModule,
  resetDebugBundleNativeModule
} from "../src/testing.js";

describe("native module resolution", () => {
  afterEach(() => {
    delete (globalThis as { __DebugBundleReactNativeModule?: unknown }).__DebugBundleReactNativeModule;
    resetDebugBundleNativeModule();
  });

  it("uses explicit test overrides first", () => {
    const module = installRecordingNativeModule();

    expect(getNativeModule()).toBe(module);
  });

  it("uses the React Native global test hook before degrading", () => {
    const module = createRecordingNativeModule();
    (globalThis as { __DebugBundleReactNativeModule?: unknown }).__DebugBundleReactNativeModule = module;
    resetDebugBundleNativeModule();

    expect(getNativeModule()).toBe(module);
  });

  it("returns null when no native module can be resolved", () => {
    resetDebugBundleNativeModule();

    expect(getNativeModule()).toBeNull();
  });
});
