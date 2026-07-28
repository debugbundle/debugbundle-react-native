import type { TurboModule } from "react-native";
import type { UnsafeObject } from "react-native/Libraries/Types/CodegenTypes";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  initialize(config: UnsafeObject): Promise<UnsafeObject>;
  enqueueCanonicalEvent?(event: UnsafeObject): Promise<boolean>;
  enqueueEvent(event: UnsafeObject): Promise<void>;
  captureProbe?(label: string, data: UnsafeObject, occurredAt: string): Promise<boolean>;
  isProbeActive?(label: string): boolean;
  flush(): Promise<void>;
  getStatus(): Promise<UnsafeObject>;
  setContext(key: string, value: UnsafeObject): Promise<void>;
  setContextValue?(key: string, entry: UnsafeObject): Promise<void>;
  activateProbeTriggerToken?(token: string): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>("DebugBundleReactNative");
