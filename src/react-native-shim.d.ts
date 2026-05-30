declare module "react-native" {
  export interface TurboModule {}

  export const TurboModuleRegistry: {
    get<T extends TurboModule>(name: string): T | null;
    getEnforcing<T extends TurboModule>(name: string): T;
  };

  export const NativeModules: Record<string, unknown>;
}

declare module "react-native/Libraries/Types/CodegenTypes" {
  export type UnsafeObject = object;
}
