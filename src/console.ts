import type { DebugBundleClient, DebugBundleLogLevel } from "./types.js";

let restoreConsole: (() => void) | null = null;

export function captureDebugBundleConsole(client: Pick<DebugBundleClient, "captureLog"> & {
  isLogEnabled?: (level: DebugBundleLogLevel) => boolean;
}): () => void {
  if (restoreConsole) {
    return restoreConsole;
  }
  const originalWarn = console.warn;
  const originalError = console.error;
  let inCapture = false;
  console.warn = (...args: unknown[]) => {
    capture("warning", args);
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    capture("error", args);
    originalError(...args);
  };
  restoreConsole = () => {
    console.warn = originalWarn;
    console.error = originalError;
    restoreConsole = null;
  };
  return restoreConsole;

  function capture(level: DebugBundleLogLevel, args: unknown[]): void {
    if (inCapture) {
      return;
    }
    inCapture = true;
    try {
      if (client.isLogEnabled?.(level) === false) return;
      client.captureLog(args.map(String).join(" "), level, { source: "console" });
    } catch {
      // Console instrumentation must not change host logging behavior.
    } finally {
      inCapture = false;
    }
  }
}
