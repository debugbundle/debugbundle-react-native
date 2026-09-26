# DebugBundle React Native

React Native SDK for DebugBundle mobile apps.

This package targets iOS and Android React Native apps. It is a mobile direct-ingestion SDK, not a browser relay host: it does not provide CORS, `allowedOrigins`, `transportMode`, or `/debugbundle/browser` helpers.

## Status

Published implementation:

- TypeScript facade and instance client.
- Safe degraded mode when the native module is unavailable, including Expo Go.
- JS-originated event enqueueing through a native module contract.
- React error boundary helper.
- React Navigation breadcrumb helpers.
- `fetch` and `XMLHttpRequest` instrumentation with target-scoped `X-DebugBundle-Trace-Id`.
- JS-side bounded serialization and redaction before native queue persistence.
- Local log level, log capture, and request capture switches are checked before event construction or `beforeSend`. A stalled native bridge accepts at most 224 lower-priority event calls / 3 MiB and reserves 32 more calls / 1 MiB for errors and exceptions. Each event is capped at 64 KiB; excess calls are discarded.
- Android and iOS native wrappers that delegate queueing, config/status, request capture, crash/error capture, flushing, and probe trigger activation to the native SDK foundations.
- Repository-local Android Java, Swift, and Objective-C++ wrapper tests with an
  enforced 80% line-coverage floor for every handwritten native bridge source.
- Clean-install React Native app smoke coverage for Android and iOS, including New Architecture codegen/autolinking.

## Runtime Support

| Lane | Support |
| --- | --- |
| Minimum compatibility | React Native 0.76+, React 18.2+, iOS 15+, Android minSdk 23 |
| Recommended production | Current stable React Native 0.87.x with Hermes and the New Architecture enabled where your app supports it |
| Installed-base compatibility | React Native 0.76 through current stable, including legacy bridge apps |
| Rolling CI | TypeScript/package smoke, Android bridge compile on RN 0.76.9, 0.82.1, 0.85.3, and 0.87.1, bare iOS compatibility/current-installed-base lanes, plus Expo SDK 57 / RN 0.86 Android and iOS development builds |
| Expo | Expo development builds and prebuild; Expo Go is degraded because it cannot load custom native modules |

JSC compatibility is best-effort where the selected React Native lane still supports it. Hermes is the primary tested JavaScript engine.

## Install

```sh
npm install @debugbundle/sdk-react-native
cd ios && pod install
```

iOS autolinking resolves the `DebugBundleReactNative.podspec`, which depends on the native `DebugBundle` pod from the Swift SDK.

Android apps must enable core library desugaring because the native Android SDK
uses Java APIs that require desugaring on the SDK's minimum API level:

```gradle
android {
    compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
        coreLibraryDesugaringEnabled true
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
}
```

The Expo config plugin applies this Android Gradle configuration during prebuild.

## Basic Setup

```ts
import { DebugBundle } from "@debugbundle/sdk-react-native";

DebugBundle.init({
  projectToken: process.env.EXPO_PUBLIC_DEBUGBUNDLE_TOKEN,
  service: "checkout-mobile",
  environment: __DEV__ ? "development" : "production",
  releaseChannel: "app-store",
  tracePropagationTargets: ["https://api.example.com"]
});
```

Project tokens are write-only mobile ingestion tokens, but they are still extractable from the app binary and JS bundle. Do not treat them as a secret boundary.

## Network Instrumentation

```ts
import { instrumentDebugBundleNetwork } from "@debugbundle/sdk-react-native/network";

instrumentDebugBundleNetwork({
  tracePropagationTargets: ["https://api.example.com"]
});
```

Trace headers are added only to relative URLs or configured first-party targets. Request and response bodies are not captured by default.

## React Error Boundary

```tsx
import { DebugBundleErrorBoundary } from "@debugbundle/sdk-react-native/react";

export function App() {
  return (
    <DebugBundleErrorBoundary>
      <CheckoutRoot />
    </DebugBundleErrorBoundary>
  );
}
```

## React Navigation

```tsx
import { NavigationContainer } from "@react-navigation/native";
import {
  createDebugBundleNavigationRef,
  onDebugBundleNavigationReady,
  onDebugBundleNavigationStateChange
} from "@debugbundle/sdk-react-native/navigation";

export const navigationRef = createDebugBundleNavigationRef();

export function AppNavigation() {
  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => onDebugBundleNavigationReady(navigationRef)}
      onStateChange={() => onDebugBundleNavigationStateChange(navigationRef)}
    >
      {/* navigators */}
    </NavigationContainer>
  );
}
```

## Expo

Expo development builds and prebuild are supported through the config plugin. Expo Go cannot load the native module, so the SDK reports degraded status and does not claim durable native queueing, native crash evidence, native device context, or remote-probe parity.

## Verification

Run `make verify` for the TypeScript, package, and JavaScript coverage gates.
Run `make android-test` for the Android bridge unit/coverage gate and
`make ios-test` on macOS for the Swift and Objective-C++ bridge gates.
`make verify-native` combines the JavaScript and available platform-native
checks.

## Release

The package publishes to npm from `v*` tags through GitHub Actions. Configure an npm GitHub Actions trusted publisher for `debugbundle/debugbundle-react-native` and `release.yml`, with a blank environment and direct `npm publish` enabled. Publishing uses OIDC without a long-lived npm token. Make sure the tag matches `package.json` exactly. The 3.0.1 wrapper pins Android 3.0.1 and requires Swift 3.0.1 or later within the compatible 3.x CocoaPods line. `make check-protected-native-pins` checks the wrapper, native pins and embedded SDK versions together. Publish only after the exact Android and Swift artifacts are available and their published-consumer checks pass. The release workflow compiles and runs clean apps against those published artifacts on Android API 37 and Xcode 27 before npm publication.

Probe and context native calls share the event bridge's pending count and byte limits, including reserved exception capacity. Saturated auxiliary calls are discarded without evaluating probe suppliers. Probe labels are limited to 128 characters. Persistent JS context retains at most 50 fields with keys up to 128 characters, and field-sensitive privacy runs before local retention and native handoff. Throwing capture context accessors are withheld without escaping into application code. The native 3.x SDKs perform queue persistence on their bounded background workers; abrupt process termination before persistence completes can lose admitted events.

Version 3 defers optional `beforeSend` callbacks until capture returns. Callbacks run on the JavaScript event loop and must return promptly. Pending preparation and native delivery share bounded count/byte limits; valid expanded replacements may be dropped under pressure. See [the version3 migration guide](MIGRATION-3.0.md).
