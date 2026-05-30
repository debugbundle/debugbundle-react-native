import type { TurboModule } from "react-native";
import type { UnsafeObject } from "react-native/Libraries/Types/CodegenTypes";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  initialize(config: UnsafeObject): Promise<UnsafeObject>;
  enqueueEvent(event: UnsafeObject): Promise<void>;
  flush(): Promise<void>;
  getStatus(): Promise<UnsafeObject>;
  setContext(key: string, value: unknown): Promise<void>;
  activateProbeTriggerToken?(token: string): Promise<boolean>;
}

export default TurboModuleRegistry.getEnforcing<Spec>("DebugBundleReactNative");
