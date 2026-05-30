import { resetNativeModuleCacheForTesting, setNativeModuleForTesting } from "./native.js";
import type { DebugBundleEventEnvelope, NativeDebugBundleModule, NativeDebugBundleState, ResolvedDebugBundleConfig } from "./types.js";

export interface RecordingNativeModule extends NativeDebugBundleModule {
  events: DebugBundleEventEnvelope[];
  config: ResolvedDebugBundleConfig | null;
}

export function createRecordingNativeModule(initialState: NativeDebugBundleState = { status: "healthy", lastEventAt: null }): RecordingNativeModule {
  const state = { ...initialState };
  return {
    events: [],
    config: null,
    initialize(config) {
      this.config = config;
      return state;
    },
    enqueueEvent(event) {
      this.events.push(event);
      state.lastEventAt = Date.now();
    },
    flush() {
      state.status = "healthy";
    },
    getStatus() {
      return state;
    },
    setContext() {
      return undefined;
    },
    activateProbeTriggerToken() {
      return true;
    }
  };
}

export function installRecordingNativeModule(module: RecordingNativeModule = createRecordingNativeModule()): RecordingNativeModule {
  setNativeModuleForTesting(module);
  return module;
}

export function resetDebugBundleNativeModule(): void {
  setNativeModuleForTesting(undefined);
  resetNativeModuleCacheForTesting();
}
