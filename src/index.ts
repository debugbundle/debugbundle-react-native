import { DebugBundleReactNativeClient, createDebugBundleClient } from "./client.js";
import { captureDebugBundleConsole } from "./console.js";
import { installDebugBundleErrorHandlers } from "./errors.js";
import type {
  DebugBundleCaptureContext,
  DebugBundleClient,
  DebugBundleConfig,
  DebugBundleLogLevel,
  DebugBundleProbeOptions,
  DebugBundleRequestInfo,
  DebugBundleResponseInfo,
  DebugBundleStatus
} from "./types.js";

const singleton = new DebugBundleReactNativeClient();

export const DebugBundle = {
  init(config: DebugBundleConfig): void {
    singleton.init(config);
    if (config.captureErrors !== false) {
      installDebugBundleErrorHandlers(singleton, {
        captureUnhandledRejections: config.captureUnhandledRejections !== false
      });
    }
    if (config.captureConsole === true) {
      captureDebugBundleConsole(singleton);
    }
  },
  captureException(error: unknown, context?: DebugBundleCaptureContext): void {
    singleton.captureException(error, context);
  },
  captureError(error: unknown, context?: DebugBundleCaptureContext): void {
    singleton.captureError(error, context);
  },
  captureLog(message: string, level?: DebugBundleLogLevel, context?: DebugBundleCaptureContext): void {
    singleton.captureLog(message, level, context);
  },
  captureRequest(request: DebugBundleRequestInfo, response: DebugBundleResponseInfo, context?: DebugBundleCaptureContext): void {
    singleton.captureRequest(request, response, context);
  },
  captureMessage(message: string, level?: DebugBundleLogLevel, context?: DebugBundleCaptureContext): void {
    singleton.captureMessage(message, level, context);
  },
  setContext(key: string, value: unknown): void {
    singleton.setContext(key, value);
  },
  probe(label: string, data: unknown | (() => unknown), options?: DebugBundleProbeOptions): void {
    singleton.probe(label, data, options);
  },
  flush(): Promise<void> {
    return singleton.flush();
  },
  activateProbeTriggerToken(token: string): Promise<boolean> {
    return singleton.activateProbeTriggerToken(token);
  },
  recordBreadcrumb(type: string, data?: Record<string, unknown>): void {
    singleton.recordBreadcrumb(type, data);
  },
  recordScreen(screenName: string, previousScreen?: string | null, source?: string): void {
    singleton.recordScreen(screenName, previousScreen, source);
  },
  get status(): DebugBundleStatus {
    return singleton.status;
  },
  get lastEventAt(): number | null {
    return singleton.lastEventAt;
  }
};

export { createDebugBundleClient, DebugBundleReactNativeClient };
export { captureDebugBundleConsole };
export { installDebugBundleErrorHandlers };
export type {
  DebugBundleCaptureContext,
  DebugBundleClient,
  DebugBundleConfig,
  DebugBundleLogLevel,
  DebugBundleProbeOptions,
  DebugBundleRequestInfo,
  DebugBundleResponseInfo,
  DebugBundleStatus
};
