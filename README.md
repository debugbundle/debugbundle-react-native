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
- Android and iOS native wrappers that delegate queueing, config/status, request capture, crash/error capture, flushing, and probe trigger activation to the native SDK foundations.
- Clean-install React Native app smoke coverage for Android and iOS, including New Architecture codegen/autolinking.

## Runtime Support

| Lane | Support |
| --- | --- |
| Minimum compatibility | React Native 0.76+, React 18.2+, iOS 15+, Android minSdk 23 |
| Recommended production | Current stable React Native 0.85.x with Hermes and the New Architecture enabled where your app supports it |
| Installed-base compatibility | React Native 0.76 through current stable, including legacy bridge apps |
| Rolling CI | TypeScript/package smoke, Android bridge compile on RN 0.76.9, 0.82.1, and 0.85.3, plus current-stable Android and iOS clean-app smokes |
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

## Release

The package publishes to npm from `v*` tags through GitHub Actions. Configure the repository secret `NPM_TOKEN`, make sure the tag matches `package.json` exactly, for example `v0.1.1`, and push the tag after the native Swift `DebugBundle` pod version referenced by `DebugBundleReactNative.podspec` is available to CocoaPods consumers.
