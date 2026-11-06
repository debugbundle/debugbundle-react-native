import { afterEach, describe, expect, it, vi } from "vitest";
import { installDebugBundleErrorHandlers } from "../src/errors.js";
import { withReportingError, isReportingError } from "../src/automatic-error.js";
import { captureDebugBundleConsole } from "../src/console.js";
import type { DebugBundleClient } from "../src/types.js";

describe("React Native JS error handlers", () => {
  it("keeps nested synchronous ownership and clears it after host failure", () => {
    const error = new Error("native");
    expect(() => withReportingError(error, () => {
      withReportingError(error, () => expect(isReportingError(error)).toBe(true));
      expect(isReportingError(error)).toBe(true);
      throw error;
    })).toThrow(error);
    expect(isReportingError(error)).toBe(false);
  });
  it("does not report a host handler's console echo as a second exception", () => {
    const original = console.error;
    const host = vi.fn(); console.error = host;
    let handler: ((error: unknown) => void) | undefined;
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
      getGlobalHandler: () => (error: unknown) => console.error(error),
      setGlobalHandler: (next: typeof handler) => { handler = next; }
    };
    const client = { captureException: vi.fn(), captureLog: vi.fn() };
    const stopConsole = captureDebugBundleConsole(client);
    const stopErrors = installDebugBundleErrorHandlers(client);
    try {
      const error = new Error("synthetic");
      handler?.(error);
      expect(client.captureException).toHaveBeenCalledTimes(1);
      expect(client.captureLog).not.toHaveBeenCalled();
      expect(host).toHaveBeenCalledWith(error);
      console.error(error); // A later explicit report is not guessed to be the same occurrence.
      expect(client.captureException).toHaveBeenCalledTimes(2);
    } finally { stopErrors(); stopConsole(); console.error = original; }
  });
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

  it("captures unhandled rejections and removes the exact listener", () => {
    const listeners = new Map<string, (event: PromiseRejectionEvent) => void>();
    const addEventListener = vi.fn((type: string, listener: (event: PromiseRejectionEvent) => void) => {
      listeners.set(type, listener);
    });
    const removeEventListener = vi.fn();
    Object.defineProperty(globalThis, "addEventListener", {
      configurable: true,
      value: addEventListener
    });
    Object.defineProperty(globalThis, "removeEventListener", {
      configurable: true,
      value: removeEventListener
    });
    const client = { captureException: vi.fn() } as unknown as DebugBundleClient;

    const restore = installDebugBundleErrorHandlers(client);
    expect(installDebugBundleErrorHandlers(client)).toBe(restore);
    listeners.get("unhandledrejection")?.({ reason: "rejected" } as PromiseRejectionEvent);
    listeners.get("unhandledrejection")?.({ reason: null } as PromiseRejectionEvent);
    restore();

    expect(client.captureException).toHaveBeenNthCalledWith(1, "rejected", {
      source: "unhandledrejection"
    });
    expect(client.captureException.mock.calls[1]?.[0]).toBeInstanceOf(Error);
    expect(removeEventListener).toHaveBeenCalledWith(
      "unhandledrejection",
      listeners.get("unhandledrejection")
    );
  });

  it("captures a nonfatal global error when no previous handler exists", () => {
    let handler: ((error: unknown, isFatal?: boolean) => void) | undefined;
    const setGlobalHandler = vi.fn((next: typeof handler) => {
      handler = next;
    });
    (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
      setGlobalHandler
    };
    const client = { captureException: vi.fn() } as unknown as DebugBundleClient;

    const restore = installDebugBundleErrorHandlers(client);
    handler?.(new Error("recoverable"));
    restore();

    expect(client.captureException).toHaveBeenCalledWith(expect.any(Error), {
      source: "react-native-global-error",
      fatal: false
    });
    expect(setGlobalHandler).toHaveBeenCalledOnce();
  });
});
