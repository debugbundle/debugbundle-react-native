import { afterEach, describe, expect, it, vi } from "vitest";
import { installDebugBundleErrorHandlers } from "../src/errors.js";
import type { DebugBundleClient } from "../src/types.js";

describe("React Native JS error handlers", () => {
  afterEach(() => {
    delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
    delete (globalThis as { addEventListener?: unknown }).addEventListener;
    delete (globalThis as { removeEventListener?: unknown }).removeEventListener;
  });

  it("captures global RN errors and preserves the previous host handler", () => {
    const previous = vi.fn();
    let handler: ((error: unknown, isFatal?: boolean) => void) | undefined;
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
      getGlobalHandler: () => previous,
      setGlobalHandler: (next: typeof handler) => {
        handler = next;
      }
    };
    const client = { captureException: vi.fn() } as unknown as DebugBundleClient;

    const restore = installDebugBundleErrorHandlers(client);
    const error = new Error("boom");
    handler?.(error, true);

    expect(client.captureException).toHaveBeenCalledWith(error, {
      source: "react-native-global-error",
      fatal: true
    });
    expect(previous).toHaveBeenCalledWith(error, true);
    restore();
  });

  it("can be disabled for unhandled rejection listener installation", () => {
    const client = { captureException: vi.fn() } as unknown as DebugBundleClient;
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    Object.defineProperty(globalThis, "addEventListener", {
      configurable: true,
      value: addEventListener
    });
    Object.defineProperty(globalThis, "removeEventListener", {
      configurable: true,
      value: removeEventListener
    });

    const restore = installDebugBundleErrorHandlers(client, { captureUnhandledRejections: false });

    expect(addEventListener).not.toHaveBeenCalledWith("unhandledrejection", expect.any(Function));
    restore();
  });
});
