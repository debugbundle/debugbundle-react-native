import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const swiftSdkRoot = process.env.SWIFT_SDK_ROOT ?? resolve(repoRoot, "../debugbundle-swift");
const androidSdkRoot = process.env.ANDROID_SDK_ROOT ?? resolve(repoRoot, "../debugbundle-android/.android-sdk");
const androidHome = process.env.ANDROID_USER_HOME ?? resolve(repoRoot, "../debugbundle-android/.android-home");
const smokeRoot = resolve(repoRoot, ".smoke");
const appDir = resolve(smokeRoot, "rn-clean-app");
const gradleCache = resolve(repoRoot, ".gradle-cache-rn-smoke");
const projectName = "DebugBundleSmoke";
const reactNativeVersion = process.env.RN_SMOKE_VERSION ?? "0.85.3";
const cliVersion = process.env.RN_SMOKE_CLI_VERSION ?? "20.1.3";

const args = new Set(process.argv.slice(2));
const platforms = args.has("--ios")
  ? ["ios"]
  : args.has("--android")
    ? ["android"]
    : ["ios", "android"];
const reuseFixture = args.has("--reuse-fixture");
const skipBuild = args.has("--skip-build");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit"
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${output ? `\n${output}` : ""}`);
  }

  return result.stdout ?? "";
}

function packSdk() {
  if (!skipBuild) {
    run("npm", ["run", "build"]);
  }
  mkdirSync(smokeRoot, { recursive: true });
  const output = run("npm", ["pack", "--pack-destination", smokeRoot], { capture: true });
  const tarball = output.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  if (!tarball) {
    throw new Error("npm pack did not report a tarball path");
  }
  return resolve(smokeRoot, tarball);
}

function createApp(tarballPath) {
  if (!reuseFixture || !existsSync(resolve(appDir, "package.json"))) {
    rmSync(appDir, { recursive: true, force: true });
    mkdirSync(smokeRoot, { recursive: true });
    run("npx", [
      "--yes",
      `@react-native-community/cli@${cliVersion}`,
      "init",
      projectName,
      "--version",
      reactNativeVersion,
      "--pm",
      "npm",
      "--directory",
      appDir,
      "--skip-install",
      "--install-pods",
      "false",
      "--skip-git-init",
      "--replace-directory",
      "true"
    ]);
  }

  run("npm", ["install", "--legacy-peer-deps"], { cwd: appDir });
  run("npm", ["install", "--legacy-peer-deps", tarballPath], { cwd: appDir });
  patchAppEntrypoint();
  patchIosPodfile();
  patchAndroidGradle();
  assertAutolinkingConfig();
}

function patchAppEntrypoint() {
  const appPath = resolve(appDir, "App.tsx");
  if (!existsSync(appPath)) {
    return;
  }

  const original = readFileSync(appPath, "utf8");
  if (original.includes("@debugbundle/sdk-react-native")) {
    return;
  }

  const patched = original.replace(
    "import {",
    "import {DebugBundle} from '@debugbundle/sdk-react-native';\nimport {"
  ).replace(
    /function App\(\): React\.JSX\.Element \{/,
    `function App(): React.JSX.Element {\n  DebugBundle.init({projectToken: 'rn-smoke-token', service: 'rn-smoke', enabled: false});`
  );
  writeFileSync(appPath, patched);
}

function patchIosPodfile() {
  const podfilePath = resolve(appDir, "ios", "Podfile");
  if (!existsSync(podfilePath)) {
    return;
  }

  const podfile = readFileSync(podfilePath, "utf8");
  if (podfile.includes("pod 'DebugBundle'")) {
    return;
  }

  const escapedSwiftPath = swiftSdkRoot.replaceAll("'", "\\'");
  const patched = podfile.replace(
    /target ['"]DebugBundleSmoke['"] do\n/,
    (match) => `${match}  pod 'DebugBundle', :path => '${escapedSwiftPath}'\n`
  );
  writeFileSync(podfilePath, patched);
}

function patchAndroidGradle() {
  const buildGradlePath = resolve(appDir, "android", "app", "build.gradle");
  if (!existsSync(buildGradlePath)) {
    return;
  }

  let buildGradle = readFileSync(buildGradlePath, "utf8");
  if (!buildGradle.includes("coreLibraryDesugaringEnabled true")) {
    buildGradle = buildGradle.replace(
      /android \{\n/,
      "android {\n    compileOptions {\n        sourceCompatibility JavaVersion.VERSION_17\n        targetCompatibility JavaVersion.VERSION_17\n        coreLibraryDesugaringEnabled true\n    }\n"
    );
  }
  if (!buildGradle.includes("com.android.tools:desugar_jdk_libs")) {
    buildGradle = buildGradle.replace(
      /dependencies \{\n/,
      'dependencies {\n    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")\n'
    );
  }
  writeFileSync(buildGradlePath, buildGradle);
}

function assertAutolinkingConfig() {
  const output = run("npx", ["react-native", "config"], { cwd: appDir, capture: true });
  const config = JSON.parse(output);
  const dependency = config.dependencies?.["@debugbundle/sdk-react-native"];
  if (!dependency) {
    throw new Error("React Native autolinking did not discover @debugbundle/sdk-react-native");
  }
  if (!dependency.platforms?.ios || !dependency.platforms?.android) {
    throw new Error("React Native autolinking did not discover both iOS and Android platform configs");
  }
}

function runIosSmoke() {
  run("pod", ["install"], { cwd: resolve(appDir, "ios") });
  run("xcodebuild", [
    "-workspace",
    resolve(appDir, "ios", `${projectName}.xcworkspace`),
    "-scheme",
    projectName,
    "-configuration",
    "Debug",
    "-sdk",
    "iphonesimulator",
    "-destination",
    "generic/platform=iOS Simulator",
    "CODE_SIGNING_ALLOWED=NO",
    "build"
  ]);
}

function runAndroidSmoke() {
  mkdirSync(gradleCache, { recursive: true });
  mkdirSync(androidHome, { recursive: true });

  const image = process.env.RN_SMOKE_ANDROID_IMAGE ?? "debugbundle-react-native-android-smoke:local";
  const platform = process.env.DOCKER_PLATFORM ?? "linux/amd64";
  run("docker", ["build", "--platform", platform, "-f", resolve(repoRoot, "smoke/android.Dockerfile"), "-t", image, resolve(repoRoot, "smoke")]);
  run("docker", [
    "run",
    "--rm",
    "-t",
    "--platform",
    platform,
    "-v",
    `${appDir}:/workspace`,
    "-v",
    `${androidSdkRoot}:/android-sdk`,
    "-v",
    `${androidHome}:/android-home`,
    "-v",
    `${gradleCache}:/root/.gradle`,
    "-w",
    "/workspace/android",
    "-e",
    "ANDROID_SDK_ROOT=/android-sdk",
    "-e",
    "ANDROID_HOME=/android-sdk",
    "-e",
    "ANDROID_USER_HOME=/android-home",
    image,
    "./gradlew",
    "--no-daemon",
    "--console=plain",
    "-Dorg.gradle.vfs.watch=false",
    ":app:assembleDebug"
  ]);
}

const tarballPath = packSdk();
createApp(tarballPath);

if (platforms.includes("ios")) {
  runIosSmoke();
}
if (platforms.includes("android")) {
  runAndroidSmoke();
}

console.log(`React Native clean app smoke passed for ${platforms.join(", ")}`);
