import type { DebugBundleClient, DebugBundleLogLevel } from "./types.js";
import { isReportingError } from "./automatic-error.js";

let restoreConsole: (() => void) | null = null;

export function captureDebugBundleConsole(client: Pick<DebugBundleClient, "captureLog"> & {
  captureException?: DebugBundleClient["captureException"];
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
      const error = args.slice(0, 3).find(value => value instanceof Error);
      if (level === "error" && error instanceof Error && client.captureException !== undefined) {
        if (isReportingError(error)) return;
        client.captureException(error, { source: "console", log_message: args.filter(value => typeof value === "string").join(" ") });
        return;
      }
      client.captureLog(args.map(String).join(" "), level, { source: "console" });
    } catch {
      // Console instrumentation must not change host logging behavior.
    } finally {
      inCapture = false;
    }
  }
}
