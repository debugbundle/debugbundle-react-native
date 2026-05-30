import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const androidModule = readFileSync(
  new URL("../android/src/main/java/com/debugbundle/reactnative/DebugBundleReactNativeModule.java", import.meta.url),
  "utf8"
);
const androidBuildGradle = readFileSync(new URL("../android/build.gradle", import.meta.url), "utf8");
const iosModule = readFileSync(new URL("../ios/DebugBundleReactNative.swift", import.meta.url), "utf8");
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

describe("repository package and release gates", () => {
  it("declares the publishable React Native package shape", () => {
    expect(packageJson.name).toBe("@debugbundle/sdk-react-native");
    expect(packageJson.main).toBe("./dist/index.js");
    expect(packageJson.types).toBe("./dist/index.d.ts");
    expect(packageJson.repository.url).toBe("git+https://github.com/debugbundle/debugbundle-react-native.git");
    expect(packageJson.publishConfig.access).toBe("public");
    expect(packageJson.exports).toHaveProperty("./network");
    expect(packageJson.exports).toHaveProperty("./navigation");
    expect(packageJson.exports).toHaveProperty("./react");
    expect(packageJson.exports).toHaveProperty("./testing");
    expect(packageJson.exports).toHaveProperty("./errors");
    expect(packageJson.exports).toHaveProperty("./console");
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
  });

  it("runs the mandatory standalone SDK verification gates in CI", () => {
    expect(ci).toContain("make verify");
    expect(ci).toContain("Android bridge compile");
    expect(ci).toContain(":debugbundle-react-native:compileDebugJavaWithJavac");
    expect(ci).toContain("iOS bridge static check");
    expect(ci).toContain("make rn-smoke-android");
    expect(ci).toContain("make rn-smoke-ios");
    expect(ci).not.toContain("secrets.");
  });

  it("publishes the npm package only through an explicit release workflow", () => {
    expect(release).toContain("tags:");
    expect(release).toContain("Validate tag matches package version");
    expect(release).toContain("make verify");
    expect(release).toContain("npm run build");
    expect(release).toContain("npm pack --dry-run");
    expect(release).toContain("secrets.NPM_TOKEN");
    expect(release).toContain("npm publish --access public");
    expect(release).toContain("Verify npm registry visibility");
    expect(release).toContain("npm view \"@debugbundle/sdk-react-native@${PACKAGE_VERSION}\"");
  });
});
