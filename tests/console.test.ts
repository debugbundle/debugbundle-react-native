import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDebugBundleConsole } from "../src/console.js";
import type { DebugBundleClient } from "../src/types.js";

describe("console capture", () => {
  const originalWarn = console.warn;
  const originalError = console.error;

  afterEach(() => {
    console.warn = originalWarn;
    console.error = originalError;
  });

  it("captures warn and error without swallowing host console output", () => {
    const captureLog = vi.fn();
    const hostWarn = vi.fn();
    const hostError = vi.fn();
    console.warn = hostWarn;
    console.error = hostError;

    const restore = captureDebugBundleConsole({ captureLog } as unknown as DebugBundleClient);
    console.warn("slow", 1);
    console.error("boom");

    expect(captureLog).toHaveBeenCalledWith("slow 1", "warning", { source: "console" });
    expect(captureLog).toHaveBeenCalledWith("boom", "error", { source: "console" });
    expect(hostWarn).toHaveBeenCalledWith("slow", 1);
    expect(hostError).toHaveBeenCalledWith("boom");
    restore();
  });
});
