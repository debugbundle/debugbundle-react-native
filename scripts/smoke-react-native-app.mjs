import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const swiftSdkRoot = process.env.SWIFT_SDK_ROOT ?? resolve(repoRoot, "../debugbundle-swift");
const androidSdkSource = process.env.DEBUGBUNDLE_ANDROID_SDK_SOURCE ?? resolve(repoRoot, "../debugbundle-android");
const androidSdkRoot = process.env.ANDROID_SDK_ROOT ?? resolve(repoRoot, "../debugbundle-android/.android-sdk");
const androidHome = process.env.ANDROID_USER_HOME ?? resolve(repoRoot, "../debugbundle-android/.android-home");
const smokeRoot = resolve(repoRoot, ".smoke");
const appDir = resolve(smokeRoot, "rn-clean-app");
const gradleCache = resolve(repoRoot, ".gradle-cache-rn-smoke");
const androidMavenRepo = resolve(smokeRoot, "android-maven");
const containerAndroidMavenRepo = "/debugbundle-android-maven";
const projectName = "DebugBundleSmoke";
const reactNativeVersion = process.env.RN_SMOKE_VERSION ?? "0.85.3";
const cliVersion = process.env.RN_SMOKE_CLI_VERSION ?? "20.1.3";
const usePublishedNativeSdk = process.env.RN_SMOKE_NATIVE_SOURCE === "published";
const publishedAndroidVersion = process.env.DEBUGBUNDLE_ANDROID_VERSION ?? "1.2.0";

const args = new Set(process.argv.slice(2));
const platforms = args.has("--ios")
  ? ["ios"]
  : args.has("--android")
    ? ["android"]
    : ["ios", "android"];
const reuseFixture = args.has("--reuse-fixture");
const skipBuild = args.has("--skip-build");
const runtimeDelivery = args.has("--runtime");
const expoDevelopmentBuild = args.has("--expo");
const mockPort = Number(process.env.RN_SMOKE_MOCK_PORT ?? "18765");
const runtimeTimeoutMs = Number(process.env.RN_SMOKE_RUNTIME_TIMEOUT_MS ?? "120000");
if (runtimeDelivery && platforms.length !== 1) {
  throw new Error("Runtime delivery smoke must target exactly one platform");
}
if (expoDevelopmentBuild && platforms.length !== 1) {
  throw new Error("Expo development-build smoke must target exactly one platform");
}
let stagedAndroidVersion = null;
const receivedEventTypes = new Set();
const runtimeRequestDiagnostics = [];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit"
  });

  if (result.status !== 0 && options.allowFailure !== true) {
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

function stageAndroidSdk() {
  const gradleProperties = readFileSync(resolve(androidSdkSource, "gradle.properties"), "utf8");
  const version = gradleProperties.match(/^VERSION_NAME=(.+)$/m)?.[1]?.trim();
  if (!version) {
    throw new Error("Unable to resolve VERSION_NAME from the coordinated Android SDK source");
  }
  const stagedBomMetadata = resolve(
    androidMavenRepo,
    "com",
    "debugbundle",
    "debugbundle-android-bom",
    version,
    "maven-metadata.xml"
  );
  if (process.env.RN_SMOKE_REUSE_STAGED_ANDROID === "1" && existsSync(stagedBomMetadata)) {
    stagedAndroidVersion = version;
    return;
  }

  rmSync(androidMavenRepo, { recursive: true, force: true });
  mkdirSync(androidMavenRepo, { recursive: true });
  mkdirSync(gradleCache, { recursive: true });
  if (process.env.RN_SMOKE_ANDROID_STAGE_RUNNER === "docker") {
    const platform = process.env.DOCKER_PLATFORM ?? "linux/amd64";
    const dockerPublishedRepo = resolve(androidSdkSource, ".rn-smoke-maven");
    rmSync(dockerPublishedRepo, { recursive: true, force: true });
    run("docker", [
      "run",
      "--rm",
      "-t",
      "--platform",
      platform,
      "-v",
      `${androidSdkSource}:/android-sdk-source`,
      "-v",
      `${androidSdkRoot}:/android-sdk`,
      "-v",
      `${androidHome}:/android-home`,
      "-v",
      `${gradleCache}:/home/gradle/.gradle`,
      "-w",
      "/android-sdk-source",
      "-e",
      "ANDROID_SDK_ROOT=/android-sdk",
      "-e",
      "ANDROID_HOME=/android-sdk",
      "-e",
      "ANDROID_USER_HOME=/android-home",
      "gradle:9.4.1-jdk21",
      "sh",
      "scripts/with-android-sdk.sh",
      "gradle",
      "--no-daemon",
      `-PVERSION_NAME=${version}`,
      "-PdebugbundlePublishRepo=/android-sdk-source/.rn-smoke-maven",
      "publishAllPublicationsToSmokeRepository"
    ]);
    cpSync(dockerPublishedRepo, androidMavenRepo, { recursive: true });
    rmSync(dockerPublishedRepo, { recursive: true, force: true });
  } else {
    run("sh", [
      resolve(androidSdkSource, "scripts", "with-android-sdk.sh"),
      resolve(androidSdkSource, "gradlew"),
      "--no-daemon",
      `-PVERSION_NAME=${version}`,
      `-PdebugbundlePublishRepo=${androidMavenRepo}`,
      "publishAllPublicationsToSmokeRepository"
    ], {
      cwd: androidSdkSource,
      env: {
        ANDROID_SDK_ROOT: androidSdkRoot,
        ANDROID_HOME: androidSdkRoot,
        ANDROID_USER_HOME: androidHome
      }
    });
  }
  if (!existsSync(stagedBomMetadata)) {
    throw new Error(`Coordinated Android SDK publication did not create ${stagedBomMetadata}`);
  }
  stagedAndroidVersion = version;
}

function createApp(tarballPath) {
  if (!reuseFixture || !existsSync(resolve(appDir, "package.json"))) {
    rmSync(appDir, { recursive: true, force: true });
    mkdirSync(smokeRoot, { recursive: true });
    if (expoDevelopmentBuild) {
      run("npx", [
        "--yes",
        "create-expo-app@latest",
        appDir,
        "--template",
        "blank-typescript@sdk-57",
        "--no-install",
        "--no-agents-md",
        "--yes"
      ], { env: { CI: process.env.CI ?? "1" } });
    } else {
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
  }

  run("npm", ["install", "--legacy-peer-deps"], { cwd: appDir });
  run("npm", ["install", "--legacy-peer-deps", tarballPath], { cwd: appDir });
  if (expoDevelopmentBuild) {
    run("npx", ["expo", "install", "expo-dev-client"], { cwd: appDir });
    configureExpoPlugin();
    run("npx", ["expo", "prebuild", "--platform", platforms[0], "--clean", "--no-install"], { cwd: appDir });
  }
  patchAppEntrypoint();
  patchIosPodfile();
  patchAndroidGradle();
  assertAutolinkingConfig();
}

function configureExpoPlugin() {
  const appConfigPath = resolve(appDir, "app.json");
  const appConfig = JSON.parse(readFileSync(appConfigPath, "utf8"));
  const plugins = Array.isArray(appConfig.expo?.plugins) ? appConfig.expo.plugins : [];
  if (!plugins.some((plugin) => plugin === "@debugbundle/sdk-react-native")) {
    plugins.push("@debugbundle/sdk-react-native");
  }
  appConfig.expo = {
    ...appConfig.expo,
    plugins
  };
  writeFileSync(appConfigPath, `${JSON.stringify(appConfig, null, 2)}\n`);
}

function patchAppEntrypoint() {
  const appPath = resolve(appDir, "App.tsx");
  if (!existsSync(appPath)) {
    return;
  }

  const original = readFileSync(appPath, "utf8");
  const runtimeEndpoint = platforms.includes("android")
    ? `http://10.0.2.2:${mockPort}/v1/events`
    : `http://127.0.0.1:${mockPort}/v1/events`;
  const initialization = runtimeDelivery
    ? `DebugBundle.init({
    projectToken: 'rn-smoke-token',
    service: 'rn-runtime-smoke',
    environment: 'test',
    endpoint: '${runtimeEndpoint}',
    batchSize: 1,
    flushInterval: 250
  });
  const smokeGlobal = globalThis as typeof globalThis & {__debugbundleRuntimeSmoke?: boolean};
  if (!smokeGlobal.__debugbundleRuntimeSmoke) {
    smokeGlobal.__debugbundleRuntimeSmoke = true;
    DebugBundle.setContext('release_stage', 'smoke');
    setTimeout(() => {
      DebugBundle.captureException(new Error('rn runtime smoke'), {trace_id: 'rn-runtime-trace'});
      DebugBundle.captureRequest(
        {method: 'GET', url: 'https://example.test/failure'},
        {statusCode: 503, durationMillis: 12},
        {trace_id: 'rn-runtime-trace'}
      );
    }, 750);
  }`
    : "DebugBundle.init({projectToken: 'rn-smoke-token', service: 'rn-smoke', enabled: false});";

  let patched = original;
  if (!patched.includes("@debugbundle/sdk-react-native")) {
    patched = patched.replace(
      "import {",
      "import {DebugBundle} from '@debugbundle/sdk-react-native';\nimport {"
    );
  }
  const initializationMarker = runtimeDelivery ? "rn runtime smoke" : "service: 'rn-smoke'";
  if (!patched.includes(initializationMarker)) {
    const appFunctionPattern = /function App\(\)(?:\s*:\s*[^{]+)?\s*\{/;
    if (!appFunctionPattern.test(patched)) {
      throw new Error("Unable to locate the generated React Native App function");
    }
    patched = patched.replace(
      appFunctionPattern,
      (match) => `${match}\n  ${initialization}`
    );
  }
  if (runtimeDelivery && !patched.includes("DebugBundle.setContext('release_stage', 'smoke')")) {
    patched = patched.replace(
      "smokeGlobal.__debugbundleRuntimeSmoke = true;",
      "smokeGlobal.__debugbundleRuntimeSmoke = true;\n    DebugBundle.setContext('release_stage', 'smoke');"
    );
  }
  writeFileSync(appPath, patched);
}

function patchIosPodfile() {
  const podfilePath = resolve(appDir, "ios", "Podfile");
  if (!existsSync(podfilePath)) {
    return;
  }

  const podfile = readFileSync(podfilePath, "utf8");
  if (!usePublishedNativeSdk && !podfile.includes("pod 'DebugBundle'")) {
    const escapedSwiftPath = swiftSdkRoot.replaceAll("'", "\\'");
    const patched = podfile.replace(
      /target ['"][^'"]+['"] do\n/,
      (match) => `${match}  pod 'DebugBundle', :path => '${escapedSwiftPath}'\n`
    );
    writeFileSync(podfilePath, patched);
  }

  if (runtimeDelivery) {
    const infoPlistPath = resolve(appDir, "ios", projectName, "Info.plist");
    let infoPlist = readFileSync(infoPlistPath, "utf8");
    if (!infoPlist.includes("NSAllowsLocalNetworking")) {
      infoPlist = infoPlist.replace(
        "</dict>",
        "  <key>NSAppTransportSecurity</key>\n  <dict>\n    <key>NSAllowsLocalNetworking</key>\n    <true/>\n  </dict>\n</dict>"
      );
      writeFileSync(infoPlistPath, infoPlist);
    }
  }
}

function patchAndroidGradle() {
  if (!platforms.includes("android")) {
    return;
  }
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

  if (stagedAndroidVersion === null) {
    throw new Error("Android SDK source must be staged before patching the clean app");
  }

  const settingsPath = ["settings.gradle", "settings.gradle.kts"]
    .map((name) => resolve(appDir, "android", name))
    .find((candidate) => existsSync(candidate));
  if (!settingsPath) {
    throw new Error("Generated React Native app is missing Android settings");
  }
  let settings = readFileSync(settingsPath, "utf8");
  if (!usePublishedNativeSdk) {
    const localRepository = containerAndroidMavenRepo;
    settings = settings
      .replaceAll(androidMavenRepo, localRepository)
      .replaceAll("} maven {", "}\n        maven {");
    if (!settings.includes(localRepository)) {
      const dependencyResolutionStart = settings.indexOf("dependencyResolutionManagement");
      const dependencyRepositoriesStart = dependencyResolutionStart < 0
        ? -1
        : settings.indexOf("repositories", dependencyResolutionStart);
      if (dependencyRepositoriesStart >= 0) {
        const openingBrace = settings.indexOf("{", dependencyRepositoriesStart);
        settings = `${settings.slice(0, openingBrace + 1)}
        maven { url = uri("${localRepository}") }
${settings.slice(openingBrace + 1)}`;
      } else {
        settings += `\ndependencyResolutionManagement { repositories { maven { url = uri("${localRepository}") }; google(); mavenCentral() } }\n`;
      }
    }
    writeFileSync(settingsPath, settings);

    const rootBuildGradlePath = ["build.gradle", "build.gradle.kts"]
      .map((name) => resolve(appDir, "android", name))
      .find((candidate) => existsSync(candidate));
    if (!rootBuildGradlePath) {
      throw new Error("Generated React Native app is missing the Android root build file");
    }
    let rootBuildGradle = readFileSync(rootBuildGradlePath, "utf8");
    if (!rootBuildGradle.includes(localRepository)) {
      rootBuildGradle += `
allprojects {
    repositories {
        maven { url = uri("${localRepository}") }
    }
}
`;
      writeFileSync(rootBuildGradlePath, rootBuildGradle);
    }
  }

  const gradlePropertiesPath = resolve(appDir, "android", "gradle.properties");
  let gradleProperties = readFileSync(gradlePropertiesPath, "utf8");
  if (expoDevelopmentBuild) {
    gradleProperties = gradleProperties.replace(
      /^org\.gradle\.jvmargs=.*$/m,
      "org.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=512m"
    );
  }
  const androidArchitectures = process.env.RN_SMOKE_ANDROID_ARCHITECTURES
    ?? (runtimeDelivery || expoDevelopmentBuild ? "x86_64" : null);
  if (androidArchitectures) {
    if (/^reactNativeArchitectures=.*$/m.test(gradleProperties)) {
      gradleProperties = gradleProperties.replace(
        /^reactNativeArchitectures=.*$/m,
        `reactNativeArchitectures=${androidArchitectures}`
      );
    } else {
      gradleProperties += `\nreactNativeArchitectures=${androidArchitectures}\n`;
    }
  }
  if (!gradleProperties.includes("debugBundleAndroidVersion=")) {
    gradleProperties += `\ndebugBundleAndroidVersion=${stagedAndroidVersion}\n`;
  }
  writeFileSync(gradlePropertiesPath, gradleProperties);

  if (runtimeDelivery) {
    const manifestPath = resolve(appDir, "android", "app", "src", "main", "AndroidManifest.xml");
    let manifest = readFileSync(manifestPath, "utf8");
    if (!manifest.includes("android:usesCleartextTraffic=")) {
      manifest = manifest.replace("<application", '<application android:usesCleartextTraffic="true"');
      writeFileSync(manifestPath, manifest);
    }
  }
}

function assertAutolinkingConfig() {
  const autolinkingArgs = expoDevelopmentBuild
    ? ["expo-modules-autolinking", "react-native-config", "--json", "--platform", platforms[0]]
    : ["react-native", "config"];
  const output = run("npx", autolinkingArgs, { cwd: appDir, capture: true });
  const config = JSON.parse(output);
  const dependency = config.dependencies?.["@debugbundle/sdk-react-native"];
  if (!dependency) {
    throw new Error("React Native autolinking did not discover @debugbundle/sdk-react-native");
  }
  const expectedPlatforms = expoDevelopmentBuild ? platforms : ["ios", "android"];
  if (!expectedPlatforms.every((platform) => dependency.platforms?.[platform])) {
    throw new Error(`React Native autolinking did not discover ${expectedPlatforms.join(" and ")} platform config`);
  }
}

async function runIosSmoke() {
  run("pod", ["install"], { cwd: resolve(appDir, "ios") });
  const { workspacePath, scheme } = resolveIosBuildIdentity();
  const destination = runtimeDelivery
    ? `id=${resolveIosSimulator()}`
    : "generic/platform=iOS Simulator";
  const configuration = runtimeDelivery ? "Release" : "Debug";
  const derivedDataPath = resolve(smokeRoot, "ios-derived-data");
  run("xcodebuild", [
    "-quiet",
    "-workspace",
    workspacePath,
    "-scheme",
    scheme,
    "-configuration",
    configuration,
    "-sdk",
    "iphonesimulator",
    "-destination",
    destination,
    "-derivedDataPath",
    derivedDataPath,
    "CODE_SIGNING_ALLOWED=NO",
    ...(runtimeDelivery ? ["ONLY_ACTIVE_ARCH=YES"] : []),
    "build"
  ]);

  if (!runtimeDelivery) {
    return;
  }

  const simulatorId = destination.slice("id=".length);
  const appPath = resolve(
    derivedDataPath,
    "Build",
    "Products",
    `${configuration}-iphonesimulator`,
    `${scheme}.app`
  );
  const bundleIdentifier = run("xcrun", [
    "plutil",
    "-extract",
    "CFBundleIdentifier",
    "raw",
    resolve(appPath, "Info.plist")
  ], { capture: true }).trim();
  if (!bundleIdentifier) {
    throw new Error("Unable to resolve the React Native smoke app bundle identifier");
  }

  const server = await startMockIngestion();
  try {
    run("xcrun", ["simctl", "install", simulatorId, appPath]);
    run("xcrun", ["simctl", "terminate", simulatorId, bundleIdentifier], { allowFailure: true });
    run("xcrun", ["simctl", "launch", simulatorId, bundleIdentifier]);
    await waitForRuntimeEvents();
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function resolveIosBuildIdentity() {
  const iosDirectory = resolve(appDir, "ios");
  const workspaceName = readdirSync(iosDirectory).find(
    (entry) => entry.endsWith(".xcworkspace") && entry !== "Pods.xcworkspace"
  );
  if (!workspaceName) {
    throw new Error("Generated React Native app is missing an iOS workspace");
  }
  const workspacePath = resolve(iosDirectory, workspaceName);
  const listing = JSON.parse(
    run("xcodebuild", ["-list", "-json", "-workspace", workspacePath], { capture: true })
  );
  const schemes = listing.workspace?.schemes ?? [];
  const preferredScheme = workspaceName.slice(0, -".xcworkspace".length);
  const scheme = schemes.includes(preferredScheme)
    ? preferredScheme
    : schemes.find(
        (candidate) =>
          !candidate.startsWith("Pods-") &&
          candidate !== "DebugBundle" &&
          candidate !== "DebugBundleReactNative"
      );
  if (!scheme) {
    throw new Error("Generated React Native workspace is missing an application scheme");
  }
  return { workspacePath, scheme };
}

function resolveIosSimulator() {
  const devicesByRuntime = JSON.parse(
    run("xcrun", ["simctl", "list", "devices", "available", "-j"], { capture: true })
  ).devices;
  const devices = Object.values(devicesByRuntime)
    .flat()
    .filter((device) => device.isAvailable !== false && device.name?.startsWith("iPhone"));
  const simulator = devices.find((device) => device.state === "Booted") ?? devices[0];
  if (!simulator?.udid) {
    throw new Error("No available iPhone simulator was found");
  }
  if (simulator.state !== "Booted") {
    run("xcrun", ["simctl", "boot", simulator.udid]);
  }
  run("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);
  return simulator.udid;
}

async function runAndroidSmoke() {
  mkdirSync(gradleCache, { recursive: true });
  mkdirSync(androidHome, { recursive: true });

  const image = process.env.RN_SMOKE_ANDROID_IMAGE ?? "debugbundle-react-native-android-smoke:local";
  const platform = process.env.DOCKER_PLATFORM ?? "linux/amd64";
  const gradleWorkers = process.env.RN_SMOKE_GRADLE_WORKERS ?? "1";
  const copySourceIntoContainer = (process.env.RN_SMOKE_COPY_SOURCE ?? (process.platform === "darwin" ? "1" : "0")) === "1";
  run("docker", ["build", "--platform", platform, "-f", resolve(repoRoot, "smoke/android.Dockerfile"), "-t", image, resolve(repoRoot, "smoke")]);
  const androidBuildTask = runtimeDelivery ? ":app:assembleRelease" : ":app:assembleDebug";
  const dockerArgs = [
    "run",
    "--rm",
    "-t",
    "--platform",
    platform,
    ...(copySourceIntoContainer
      ? ["-v", `${appDir}:/smoke-source:ro`]
      : ["-v", `${appDir}:/workspace`]),
    "-v",
    `${androidSdkRoot}:/android-sdk`,
    "-v",
    `${androidHome}:/android-home`,
    "-v",
    `${gradleCache}:/root/.gradle`,
    ...(usePublishedNativeSdk
      ? []
      : ["-v", `${androidMavenRepo}:${containerAndroidMavenRepo}:ro`]),
    "-w",
    "/workspace/android",
    "-e",
    "ANDROID_SDK_ROOT=/android-sdk",
    "-e",
    "ANDROID_HOME=/android-sdk",
    "-e",
    "ANDROID_USER_HOME=/android-home",
    "-e",
    "NODE_ENV=test",
    "-e",
    "CMAKE_BUILD_PARALLEL_LEVEL=1",
    image,
    "run-android-build",
    "--no-daemon",
    `--max-workers=${gradleWorkers}`,
    "--console=plain",
    "-Dorg.gradle.vfs.watch=false",
    "-Pkotlin.compiler.execution.strategy=in-process",
    ...(usePublishedNativeSdk
      ? []
      : [`-PdebugBundleAndroidRepository=${containerAndroidMavenRepo}`]),
    androidBuildTask
  ];

  const androidSmokeOutput = resolve(smokeRoot, "android-output");
  if (runtimeDelivery && copySourceIntoContainer) {
    rmSync(androidSmokeOutput, { recursive: true, force: true });
    mkdirSync(androidSmokeOutput, { recursive: true });
    dockerArgs.splice(
      dockerArgs.indexOf(image),
      0,
      "-v",
      `${androidSmokeOutput}:/smoke-output`,
      "-e",
      "RN_SMOKE_APK_OUTPUT=release/app-release.apk"
    );
  }
  run("docker", dockerArgs);

  if (!runtimeDelivery) {
    return;
  }

  const apkPath = copySourceIntoContainer
    ? resolve(androidSmokeOutput, "app-release.apk")
    : resolve(
        appDir,
        "android",
        "app",
        "build",
        "outputs",
        "apk",
        "release",
        "app-release.apk"
      );
  if (!existsSync(apkPath)) {
    throw new Error(`React Native runtime smoke APK was not produced at ${apkPath}`);
  }

  const server = await startMockIngestion();
  try {
    run("adb", ["install", "-r", apkPath]);
    run("adb", ["shell", "am", "force-stop", "com.debugbundlesmoke"]);
    run("adb", ["logcat", "-c"], { allowFailure: true });
    const launchResult = run(
      "adb",
      ["shell", "am", "start", "-W", "-n", "com.debugbundlesmoke/.MainActivity"],
      { capture: true }
    ).trim();
    try {
      await delay(5_000);
      const initialProcessState = androidAppProcessState();
      if (!initialProcessState) {
        throw new Error(`Android app exited during startup; launch result: ${launchResult}`);
      }
      await waitForRuntimeEvents();
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
        collectAndroidRuntimeDiagnostics()
      );
    }
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function androidAppProcessState() {
  return run("adb", ["shell", "pidof", "com.debugbundlesmoke"], {
    allowFailure: true,
    capture: true
  }).trim();
}

function collectAndroidRuntimeDiagnostics() {
  const crashLog = run("adb", ["logcat", "-b", "crash", "-d"], {
    allowFailure: true,
    capture: true
  }).trim();
  const logcat = run("adb", ["logcat", "-d"], {
    allowFailure: true,
    capture: true
  });
  const relevantLogcat = logcat
    .split(/\r?\n/)
    .filter((line) => /com\.debugbundlesmoke|AndroidRuntime|ReactNative|SoLoader|Hermes|FATAL EXCEPTION|Process:|UnsatisfiedLinkError/i.test(line))
    .slice(-1000)
    .join("\n");
  const exitInfo = run(
    "adb",
    ["shell", "dumpsys", "activity", "exit-info", "com.debugbundlesmoke"],
    { allowFailure: true, capture: true }
  ).trim();
  return [
    `Android app pid: ${androidAppProcessState() || "not running"}`,
    `Android crash buffer:\n${crashLog || "empty"}`,
    `Android relevant logcat:\n${relevantLogcat || "unavailable"}`,
    `Android historical exit info:\n${exitInfo || "unavailable"}`
  ].join("\n");
}

async function startMockIngestion() {
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v1/sdk/config")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        probes_enabled: true,
        remote_probes_enabled: false,
        capture_policy: {
          preset: "balanced",
          capture_logs: "warning",
          capture_request_events: "failures_only",
          capture_breadcrumbs: "exception_only",
          capture_probe_events: "buffer_only",
          immediate_client_error_statuses: [],
          immediate_client_error_path_rules: []
        }
      }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/events") {
      response.writeHead(404);
      response.end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(body.events) || body.events.length === 0) {
      runtimeRequestDiagnostics.push(`invalid_batch:${JSON.stringify(body)}`);
      response.writeHead(400);
      response.end();
      return;
    }
    for (const event of body.events) {
      if (
        event?.schema_version !== "2026-03-01" ||
        event?.sdk_name !== "@debugbundle/sdk-react-native" ||
        event?.service?.name !== "rn-runtime-smoke" ||
        event?.context?.release_stage !== "smoke" ||
        typeof event?.event_id !== "string"
      ) {
        runtimeRequestDiagnostics.push(`invalid_event:${JSON.stringify(event)}`);
        response.writeHead(422);
        response.end();
        return;
      }
      receivedEventTypes.add(event.event_type);
    }
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({
      accepted: body.events.length,
      rejected: 0,
      errors: []
    }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(mockPort, "0.0.0.0", resolveListen);
  });
  return server;
}

async function waitForRuntimeEvents() {
  const deadline = Date.now() + runtimeTimeoutMs;
  while (Date.now() < deadline) {
    if (receivedEventTypes.has("frontend_exception") && receivedEventTypes.has("request_event")) {
      return;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for React Native runtime delivery; received ` +
    `${[...receivedEventTypes].join(", ") || "no events"}; diagnostics: ` +
    `${runtimeRequestDiagnostics.join(" | ") || "no ingestion requests"}`
  );
}

if (args.has("--stage-android-sdk-only")) {
  stageAndroidSdk();
  console.log(`Coordinated Android SDK ${stagedAndroidVersion} staged for React Native validation`);
  process.exit(0);
}

if (platforms.includes("android") && usePublishedNativeSdk) {
  stagedAndroidVersion = publishedAndroidVersion;
} else if (platforms.includes("android")) {
  stageAndroidSdk();
}

const tarballPath = packSdk();
createApp(tarballPath);

if (platforms.includes("ios")) {
  await runIosSmoke();
}
if (platforms.includes("android")) {
  await runAndroidSmoke();
}

console.log(`React Native clean app smoke passed for ${platforms.join(", ")}`);
