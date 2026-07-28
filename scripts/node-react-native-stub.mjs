import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The package smokes execute the public testing adapter in plain Node, which is
 * intentionally outside the supported React Native host. Install a minimal
 * package-shaped peer so the packed SDK's static native-module import resolves
 * exactly as it does under Metro without downloading or executing React Native.
 */
export async function installNodeReactNativeStub(consumerRoot) {
  const stubDirectory = join(consumerRoot, "react-native-runtime-stub");
  await mkdir(stubDirectory, { recursive: true });
  await writeFile(
    join(stubDirectory, "package.json"),
    JSON.stringify({
      name: "react-native",
      version: "0.85.3",
      type: "module",
      main: "./index.js",
      exports: {
        ".": "./index.js"
      }
    }, null, 2)
  );
  await writeFile(
    join(stubDirectory, "index.js"),
    `
      const runtimeGlobal = globalThis;
      export const TurboModuleRegistry = {
        get(name) {
          return name === "DebugBundleReactNative"
            ? runtimeGlobal.__DebugBundleReactNativeRegistryModule ?? null
            : null;
        }
      };
      export const NativeModules = {
        get DebugBundleReactNative() {
          return runtimeGlobal.__DebugBundleReactNativeLegacyModule;
        }
      };
    `
  );
  return "file:./react-native-runtime-stub";
}
