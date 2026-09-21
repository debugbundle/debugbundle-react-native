import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateNativeReleaseVersions } from "../scripts/check-protected-native-pins.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const androidModule = readFileSync(
  new URL("../android/src/main/java/com/debugbundle/reactnative/DebugBundleReactNativeModule.java", import.meta.url),
  "utf8"
);
const androidBuildGradle = readFileSync(new URL("../android/build.gradle", import.meta.url), "utf8");
const iosModule = readFileSync(new URL("../ios/DebugBundleReactNative.swift", import.meta.url), "utf8");
const iosBridge = readFileSync(new URL("../ios/DebugBundleReactNativeBridge.mm", import.meta.url), "utf8");
const podspec = readFileSync(new URL("../DebugBundleReactNative.podspec", import.meta.url), "utf8");
const expoPlugin = readFileSync(new URL("../app.plugin.js", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const androidRuntime = readFileSync(
  new URL("../.github/workflows/android-runtime-smoke.yml", import.meta.url),
  "utf8"
);
const cleanAppSmoke = readFileSync(
  new URL("../scripts/smoke-react-native-app.mjs", import.meta.url),
  "utf8"
);
const iosRuntimeLifecycle = readFileSync(
  new URL("../scripts/ios-runtime-lifecycle.mjs", import.meta.url),
  "utf8"
);

describe("repository package and release gates", () => {
  it("declares the publishable React Native package shape", () => {
    expect(packageJson.name).toBe("@debugbundle/sdk-react-native");
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.repository.url).toBe("git+https://github.com/debugbundle/debugbundle-react-native.git");
    expect(packageJson.homepage).toBe("https://debugbundle.com/docs/sdks/react-native");
    expect(packageJson.publishConfig.access).toBe("public");
    expect(packageJson.keywords).toContain("react-native");
    expect(packageJson.exports).toHaveProperty("./network");
    expect(packageJson.exports).toHaveProperty("./navigation");
    expect(packageJson.exports).toHaveProperty("./react");
    expect(packageJson.exports).toHaveProperty("./testing");
    expect(packageJson.exports).toHaveProperty("./errors");
    expect(packageJson.exports).toHaveProperty("./console");
  });

  it("keeps the wrapper and required native dependency release lines aligned", () => {
    expect(packageJson.version).toBe("2.0.0");
    expect(podspec).toContain('s.version      = "2.0.0"');
    expect(podspec).toContain('s.dependency "DebugBundle", "~> 2.0"');
    expect(androidBuildGradle).toContain('debugBundleAndroidVersion") ?: "2.0.0"');
    expect(expoPlugin).toContain('"@debugbundle/sdk-react-native", "2.0.0"');
  });

  it("requires protected major native dependencies before the next release", () => {
    const protectedLine = {
      wrapper: "2.0.0", podspec: "2.0.0", client: "2.0.0", expoPlugin: "2.0.0",
      swiftBridge: "2.0.0", swiftBridgeFallback: "2.0.0",
      androidBridge: "2.0.0", androidBridgeFallback: "2.0.0", iosDependency: "~> 2.0",
      androidGradle: "2.0.0", androidRelease: "2.0.0", androidSmoke: "2.0.0"
    };
    expect(validateNativeReleaseVersions(protectedLine)).toEqual([]);
    expect(validateNativeReleaseVersions({ ...protectedLine, iosDependency: "~> 1.3" }))
      .toContain("ios_dependency_unprotected");
    expect(validateNativeReleaseVersions({ ...protectedLine, androidGradle: "1.3.1" }))
      .toContain("android_dependency_unprotected");
    expect(validateNativeReleaseVersions({ ...protectedLine, wrapper: "1.3.0" }))
      .toContain("wrapper_major_unprotected");
    expect(validateNativeReleaseVersions({ ...protectedLine, swiftBridgeFallback: "1.3.0" }))
      .toContain("wrapper_version_mismatch:swiftBridgeFallback");
  });

  it("declares broad installed-base React Native support without allowing unknown majors", () => {
    expect(packageJson.peerDependencies.react).toBe(">=18.2 <20");
    expect(packageJson.peerDependencies["react-native"]).toBe(">=0.76 <1.0");
    expect(packageJson.peerDependencies["@react-navigation/native"]).toBe(">=6");
    expect(readme).toContain("React Native 0.76+");
    expect(readme).toContain("Current stable React Native 0.87.x");
    expect(readme).toContain("Android bridge compile on RN 0.76.9, 0.82.1, 0.85.3, and 0.87.1");
  });

  it("declares TurboModule codegen metadata for both mobile platforms", () => {
    expect(packageJson.codegenConfig).toMatchObject({
      name: "DebugBundleReactNativeSpec",
      type: "modules",
      jsSrcsDir: "src",
      android: { javaPackageName: "com.debugbundle.reactnative" }
    });
    expect(packageJson.codegenConfig.ios.modulesProvider).toHaveProperty("DebugBundleReactNative");
  });

  it("keeps React Native relay/CORS out of scope in docs", () => {
    expect(readme).toContain("mobile direct-ingestion SDK");
    expect(readme).toContain("Expo Go cannot load the native module");
    expect(readme).toContain("does not provide CORS");
    expect(readme).toContain("`allowedOrigins`, `transportMode`, or `/debugbundle/browser` helpers");
    expect(readme).not.toContain("Before public npm publication");
    expect(readme).not.toContain("Until that pod is published");
  });

  it("delegates platform bridge calls to the native SDK foundations", () => {
    expect(androidModule).toContain("com.debugbundle.android.DebugBundle");
    expect(androidModule).toContain("DebugBundleRequestInfo");
    expect(androidModule).toContain("DebugBundleResponseInfo");
    expect(androidBuildGradle).toContain('apply plugin: "com.facebook.react"');
    expect(androidBuildGradle).toContain("hostKotlinVersion");
    expect(androidBuildGradle).toContain('exclude group: "org.jetbrains.kotlin", module: "kotlin-stdlib"');
    expect(androidBuildGradle).not.toContain("org.jetbrains.kotlin.android");
    expect(iosModule).toContain("import DebugBundle");
    expect(iosModule).toContain("DebugBundleHTTPTransport");
    expect(iosModule).toContain("DebugBundleRequestInfo");
    expect(iosBridge).toContain("NativeDebugBundleReactNativeSpecJSI");
    expect(iosBridge).toContain("getTurboModule");
    expect(iosBridge).toContain("resolve:(RCTPromiseResolveBlock)resolve");
    expect(iosBridge).not.toContain("resolver:(RCTPromiseResolveBlock)resolve");
  });

  it("runs the mandatory standalone SDK verification gates in CI", () => {
    expect(ci).toContain("workflow_call:");
    expect(ci).toContain("make verify");
    expect(ci).toContain("Android bridge compile (RN ${{ matrix.rn-version }})");
    expect(ci).toContain('rn-version: ["0.76.9", "0.82.1", "0.85.3", "0.87.1"]');
    expect(ci).toContain(":debugbundle-react-native:compileDebugJavaWithJavac");
    expect(ci).toContain("iOS bridge static check");
    expect(ci).toContain("make rn-smoke-android");
    expect(ci).toContain("make rn-smoke-ios");
    expect(ci).toContain('api-level: "37.0"');
    expect(ci).toContain("Update Android SDK command-line tools");
    expect(ci).not.toContain("android-actions/setup-android");
    expect(androidRuntime).toContain('api-level: "37.0"');
    expect(androidRuntime).toContain("Update Android SDK command-line tools");
    expect(androidRuntime).not.toContain("android-actions/setup-android");
    expect(ci).toMatch(/expo-ios-development-build:[\s\S]*?runs-on: macos-26/);
    expect(cleanAppSmoke).toContain('"blank-typescript@sdk-57"');
    expect(iosRuntimeLifecycle).toContain("UIApplicationSceneManifest");
    expect(iosRuntimeLifecycle).toContain("class SceneDelegate: UIResponder, UIWindowSceneDelegate");
    expect(iosRuntimeLifecycle).toContain("configuration.delegateClass = SceneDelegate.self");
    expect(iosRuntimeLifecycle).toContain("UIWindow(windowScene: windowScene)");
    expect(ci).not.toContain("secrets.");
  });

  it("publishes the npm package only through an explicit release workflow", () => {
    expect(release).toContain("tags:");
    expect(release).toContain("uses: ./.github/workflows/ci.yml");
    expect(release).toContain("Published Android native dependency");
    expect(release).toContain("make check-protected-native-pins");
    expect(release).toContain("make rn-smoke-android-published");
    expect(release).toContain("Update Android SDK command-line tools");
    expect(release).not.toContain("android-actions/setup-android");
    expect(release).toContain('api-level: "37.0"');
    expect(release).toContain("target: google_apis");
    expect(release).toContain("make rn-runtime-android-published");
    expect(release).toContain("Published Swift native dependency");
    expect(release).toContain("make rn-smoke-ios-published");
    expect(release).toMatch(/ios-native-release:[\s\S]*?runs-on: xcode-27/);
    expect(release).toContain("make rn-runtime-ios-published");
    expect(release).toContain("needs: [verification, android-native-release, ios-native-release]");
    expect(release).toContain("Validate tag matches package version");
    expect(release).toContain("make verify");
    expect(release).toContain("npm run build");
    expect(release).toContain("npm pack --dry-run");
    expect(release).not.toContain("secrets.NPM_TOKEN");
    expect(release).not.toContain("NODE_AUTH_TOKEN");
    expect(release.split("\n  publish:\n")[1]).toContain("id-token: write");
    expect(release.split("\n  publish:\n")[0]).not.toContain("id-token: write");
    expect(release).toContain("npm install --global npm@11.5.2");
    expect(release).toContain("node scripts/publish-package.mjs");
    expect(release).toContain("Verify npm registry visibility");
    expect(release).toContain("npm view \"@debugbundle/sdk-react-native@${PACKAGE_VERSION}\"");
    expect(release).toContain("Smoke published package");
    expect(release).toContain("npm run smoke:registry");
    expect(release).toContain("Create GitHub release");
  });
});
