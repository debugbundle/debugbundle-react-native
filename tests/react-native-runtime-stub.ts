const runtimeGlobal = globalThis as typeof globalThis & {
  __DebugBundleReactNativeRegistryModule?: unknown;
  __DebugBundleReactNativeLegacyModule?: unknown;
};

export const TurboModuleRegistry = {
  get<T>(name: string): T | null {
    return name === "DebugBundleReactNative"
      ? (runtimeGlobal.__DebugBundleReactNativeRegistryModule as T | undefined) ?? null
      : null;
  },
  getEnforcing<T>(name: string): T {
    const module = this.get<T>(name);
    if (!module) {
      throw new Error(`Native module ${name} is unavailable`);
    }
    return module;
  }
};

export const NativeModules = {
  get DebugBundleReactNative(): unknown {
    return runtimeGlobal.__DebugBundleReactNativeLegacyModule;
  }
};
