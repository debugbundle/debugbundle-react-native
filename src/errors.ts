import type { DebugBundleClient } from "./types.js";

export interface ErrorHandlerInstallOptions {
  captureUnhandledRejections?: boolean;
}

let restoreHandlers: (() => void) | null = null;

export function installDebugBundleErrorHandlers(
  client: Pick<DebugBundleClient, "captureException">,
  options: ErrorHandlerInstallOptions = {}
): () => void {
  if (restoreHandlers) {
    return restoreHandlers;
  }
  const restores: Array<() => void> = [];
  const errorUtils = (globalThis as { ErrorUtils?: ReactNativeErrorUtils }).ErrorUtils;

  if (errorUtils?.setGlobalHandler) {
    const previousHandler = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((error, isFatal) => {
      client.captureException(error, {
        source: "react-native-global-error",
        fatal: Boolean(isFatal)
      });
      previousHandler?.(error, isFatal);
    });
    restores.push(() => {
      if (previousHandler) {
        errorUtils.setGlobalHandler?.(previousHandler);
      }
    });
  }

  if (options.captureUnhandledRejections !== false && hasAddEventListener(globalThis)) {
    const listener = (event: PromiseRejectionEvent) => {
      client.captureException(event.reason ?? new Error("Unhandled promise rejection"), {
        source: "unhandledrejection"
      });
    };
    globalThis.addEventListener("unhandledrejection", listener);
    restores.push(() => globalThis.removeEventListener("unhandledrejection", listener));
  }

  restoreHandlers = () => {
    for (const restore of restores.reverse()) {
      restore();
    }
    restoreHandlers = null;
  };
  return restoreHandlers;
}

interface ReactNativeErrorUtils {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
}

function hasAddEventListener(value: typeof globalThis): value is typeof globalThis & {
  addEventListener: (type: "unhandledrejection", listener: (event: PromiseRejectionEvent) => void) => void;
  removeEventListener: (type: "unhandledrejection", listener: (event: PromiseRejectionEvent) => void) => void;
} {
  return "addEventListener" in value && "removeEventListener" in value;
}
