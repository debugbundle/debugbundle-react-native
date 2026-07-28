import { NativeModules, TurboModuleRegistry } from "react-native";
import type { NativeDebugBundleModule, NativeDebugBundleState } from "./types.js";

let overrideModule: NativeDebugBundleModule | null | undefined;
let cachedReactNativeModule: NativeDebugBundleModule | null | undefined;

export function getNativeModule(): NativeDebugBundleModule | null {
  if (overrideModule !== undefined) {
    return overrideModule;
  }
  const globalValue = globalThis as typeof globalThis & {
    __DebugBundleReactNativeModule?: NativeDebugBundleModule;
    nativeFabricUIManager?: unknown;
  };
  if (globalValue.__DebugBundleReactNativeModule) {
    return globalValue.__DebugBundleReactNativeModule;
  }
  if (cachedReactNativeModule !== undefined) {
    return cachedReactNativeModule;
  }
  cachedReactNativeModule = resolveReactNativeModule();
  return cachedReactNativeModule;
}

export function setNativeModuleForTesting(module: NativeDebugBundleModule | null | undefined): void {
  overrideModule = module;
}

export function degradedNativeState(reason: string): NativeDebugBundleState {
  return {
    status: "degraded",
    lastEventAt: null,
    device: null,
    nativeModuleAvailable: false,
    degradedReason: reason
  };
}

export async function safeNativeCall<T>(operation: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch {
    return fallback;
  }
}

export function resetNativeModuleCacheForTesting(): void {
  cachedReactNativeModule = undefined;
}

function resolveReactNativeModule(): NativeDebugBundleModule | null {
  const turboModule = TurboModuleRegistry.get<NativeDebugBundleModule>("DebugBundleReactNative");
  if (turboModule) {
    return turboModule;
  }
  return (NativeModules.DebugBundleReactNative as NativeDebugBundleModule | undefined) ?? null;
}
