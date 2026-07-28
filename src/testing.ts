import { resetNativeModuleCacheForTesting, setNativeModuleForTesting } from "./native.js";
import type {
  DebugBundleEventEnvelope,
  NativeDebugBundleConfig,
  NativeDebugBundleModule,
  NativeDebugBundleState
} from "./types.js";

export interface RecordingNativeModule extends NativeDebugBundleModule {
  events: DebugBundleEventEnvelope[];
  probes: Array<{ label: string; data: unknown; occurredAt: string }>;
  context: Record<string, unknown>;
  config: NativeDebugBundleConfig | null;
  activeProbeLabels: Set<string>;
}

export function createRecordingNativeModule(initialState: NativeDebugBundleState = { status: "healthy", lastEventAt: null }): RecordingNativeModule {
  const state = { ...initialState };
  return {
    events: [],
    probes: [],
    context: {},
    config: null,
    activeProbeLabels: new Set(),
    initialize(config) {
      this.config = config;
      return state;
    },
    enqueueCanonicalEvent(event) {
      this.events.push(event);
      state.lastEventAt = Date.now();
      return true;
    },
    enqueueEvent(event) {
      this.events.push(event);
      state.lastEventAt = Date.now();
    },
    captureProbe(label, data, occurredAt) {
      this.probes.push({ label, data, occurredAt });
      return this.activeProbeLabels.has(label);
    },
    isProbeActive(label) {
      return this.activeProbeLabels.has(label);
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
    setContextValue(key, entry) {
      this.context[key] = entry.value;
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
