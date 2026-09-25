import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function source(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function extract(path, pattern) {
  const value = source(path).match(pattern)?.[1];
  if (value === undefined) throw new Error(`native_release_version_missing:${path}`);
  return value;
}

export function readNativeReleaseVersions() {
  return {
    wrapper: JSON.parse(source("package.json")).version,
    podspec: extract("DebugBundleReactNative.podspec", /s\.version\s*=\s*"([^"]+)"/),
    iosDependency: extract("DebugBundleReactNative.podspec", /s\.dependency "DebugBundle", "([^"]+)"/),
    androidGradle: extract("android/build.gradle", /debugBundleAndroidVersion = [^\n]*\?: "([^"]+)"/),
    androidRelease: extract("Makefile", /^ANDROID_NATIVE_RELEASE_VERSION \?= (\S+)/m),
    androidSmoke: extract("scripts/smoke-react-native-app.mjs", /publishedAndroidVersion = [^\n]*\?\? "([^"]+)"/),
    client: extract("src/client.ts", /DEFAULT_SDK_VERSION = "([^"]+)"/),
    expoPlugin: extract("app.plugin.js", /createRunOncePlugin\(withDebugBundle, "@debugbundle\/sdk-react-native", "([^"]+)"\)/),
    swiftBridge: extract("ios/DebugBundleReactNative.swift", /currentSDKVersion = "([^"]+)"/),
    swiftBridgeFallback: extract("ios/DebugBundleReactNative.swift", /currentSDKVersion = config\["sdkVersion"\] as\? String \?\? "([^"]+)"/),
    androidBridge: extract("android/src/main/java/com/debugbundle/reactnative/DebugBundleReactNativeModule.java", /currentSdkVersion = "([^"]+)"/),
    androidBridgeFallback: extract("android/src/main/java/com/debugbundle/reactnative/DebugBundleReactNativeModule.java", /currentSdkVersion = stringOrDefault\(config, "sdkVersion", "([^"]+)"\)/)
  };
}

export function validateNativeReleaseVersions(versions) {
  const issues = [];
  const major = Number(/^([0-9]+)\./.exec(versions.wrapper)?.[1]);
  if (!Number.isInteger(major) || major < 3) issues.push("wrapper_major_unprotected");
  for (const key of ["podspec", "client", "expoPlugin", "swiftBridge", "swiftBridgeFallback", "androidBridge", "androidBridgeFallback"]) {
    if (versions[key] !== versions.wrapper) issues.push(`wrapper_version_mismatch:${key}`);
  }
  if (versions.iosDependency !== `~> ${major}.0`) issues.push("ios_dependency_unprotected");
  const androidMajor = Number(/^([0-9]+)\./.exec(versions.androidGradle)?.[1]);
  if (!Number.isInteger(androidMajor) || androidMajor < 3 || androidMajor !== major) {
    issues.push("android_dependency_unprotected");
  }
  if (versions.androidRelease !== versions.androidGradle || versions.androidSmoke !== versions.androidGradle) {
    issues.push("android_dependency_mismatch");
  }
  return issues;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = validateNativeReleaseVersions(readNativeReleaseVersions());
  if (issues.length > 0) {
    console.error(`protected_native_pins_not_ready:${issues.join(",")}`);
    process.exitCode = 1;
  } else {
    console.log("protected_native_pins_ready");
  }
}
