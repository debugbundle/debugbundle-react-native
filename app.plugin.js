import { createRunOncePlugin, withAndroidManifest, withAppBuildGradle, withInfoPlist } from "@expo/config-plugins";

function withDebugBundle(config, props = {}) {
  const iosEnabled = props.ios !== false;
  const androidEnabled = props.android !== false;

  if (iosEnabled) {
    config = withInfoPlist(config, (expoConfig) => {
      expoConfig.modResults.DebugBundleEnabled = true;
      return expoConfig;
    });
  }

  if (androidEnabled) {
    config = withAndroidManifest(config, (expoConfig) => {
      const application = expoConfig.modResults.manifest.application?.[0];
      if (application) {
        application.$ = {
          ...application.$,
          "tools:targetApi": application.$?.["tools:targetApi"] ?? "31"
        };
      }
      return expoConfig;
    });

    config = withAppBuildGradle(config, (expoConfig) => {
      expoConfig.modResults.contents = withAndroidDesugaring(expoConfig.modResults.contents);
      return expoConfig;
    });
  }

  return config;
}

function withAndroidDesugaring(contents) {
  let next = contents;
  if (!next.includes("coreLibraryDesugaringEnabled true")) {
    next = next.replace(
      /android\s*\{\n/,
      "android {\n    compileOptions {\n        sourceCompatibility JavaVersion.VERSION_17\n        targetCompatibility JavaVersion.VERSION_17\n        coreLibraryDesugaringEnabled true\n    }\n"
    );
  }
  if (!next.includes("com.android.tools:desugar_jdk_libs")) {
    next = next.replace(
      /dependencies\s*\{\n/,
      'dependencies {\n    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")\n'
    );
  }
  return next;
}

export default createRunOncePlugin(withDebugBundle, "@debugbundle/sdk-react-native", "0.1.0");
