# DebugBundle React Native

Patch 3.1.4 preserves application hook redaction under optional-evidence limits and adopts the corrected native SDKs. Public capture APIs and event schemas remain compatible.

React Native SDK for DebugBundle mobile apps.

Version 3.1.0 adds proof-gated structured exception details and
opt-in explicit recovery through both native bridges. See the
[3.1 migration and API guide](MIGRATION-3.1.md) for options, operation scopes,
recovery examples, runtime limitations, and coordinated native dependencies.

This package targets iOS and Android React Native apps. It is a mobile direct-ingestion SDK, not a browser relay host: it does not provide CORS, `allowedOrigins`, `transportMode`, or `/debugbundle/browser` helpers.

## Installation

<a id="install"></a>

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

## Initialize

<a id="basic-setup"></a>

Initialize once in the app entry point after completing native installation. This example uses Expo’s public environment-variable support; bare React Native apps supply the token through their own build configuration. Mobile tokens are public write-only ingestion credentials. Use a native development build: Expo Go cannot load the native SDK.

```typescript
import { DebugBundle } from "@debugbundle/sdk-react-native";

DebugBundle.init({
  projectToken: process.env.EXPO_PUBLIC_DEBUGBUNDLE_TOKEN,
  environment: __DEV__ ? "development" : "production",
  service: "mobile-app"
});
```

## Integrations

React error boundaries, React Navigation, scoped fetch/XHR instrumentation, Expo development builds and native Android/iOS queues are supported.

### Capture setup details

Project tokens are write-only mobile ingestion tokens, but they are still extractable from the app binary and JS bundle. Do not treat them as a secret boundary.

### Network Instrumentation

```ts
import { instrumentDebugBundleNetwork } from "@debugbundle/sdk-react-native/network";

instrumentDebugBundleNetwork({
  tracePropagationTargets: ["https://api.example.com"]
});
```

Trace headers are added only to relative URLs or configured first-party targets. Request and response bodies are not captured by default.

### React Error Boundary

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

### React Navigation

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

### Expo

Expo development builds and prebuild are supported through the config plugin. Expo Go cannot load the native module, so the SDK reports degraded status and does not claim durable native queueing, native crash evidence, native device context, or remote-probe parity.

## First-event verification

Use an explicit setup event in a development or staging application, then confirm the matching service and environment in a received event or incident. Initialization, a healthy status and an empty queue are not delivery receipts. Keep the application running long enough for delivery; use bounded flushing only in tests or controlled teardown, never in a request handler.

```typescript
DebugBundle.captureException(new Error("DebugBundle setup check"));
```

Confirm the event in DebugBundle and inspect its incident with the CLI. Mobile queues are app-private; they are not CLI local-event directories. A native queue entry or mock endpoint receipt does not prove cloud acceptance.

## Configuration

Pass supported fields to `DebugBundle.init`. Runtime options override the resolved defaults. Set `tracePropagationTargets` only for first-party API origins; native queue limits, capture switches and privacy options remain explicit. Use `redactExactFields` to mask exact field names such as `"tag"` case-insensitively (ASCII) across JS and both native bridges without over-redacting compound keys like `"tag_name"`; existing broad `redactFields` and mandatory credential rules remain active. The token source belongs to the app build configuration, not the SDK.

See the [configuration reference](https://github.com/debugbundle/debugbundle-react-native/blob/main/src/types.ts) for exact supported fields and the [universal SDK interface](https://debugbundle.com/docs/sdks/universal-interface) for shared concepts.

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

## Native iOS source for 3.1.4

To use the latest native patch independently of Trunk, bare React Native apps add this source inside their
application target in `ios/Podfile`:

```ruby
pod 'DebugBundle', :git => 'https://github.com/debugbundle/debugbundle-swift.git', :tag => 'v3.1.5'
```

The Expo config plugin adds this declaration during prebuild. It preserves an
explicit `DebugBundle` declaration; existing pins to Swift `>=3.1.1` remain compatible. Advanced consumers managing the native source themselves may set
`["@debugbundle/sdk-react-native", { "iosNativeSource": "manual" }]`.
Existing Trunk pods remain available. New versions resolve from immutable Git
without requiring a new Trunk write. Expo Go still cannot load native modules.

## Verification

Run `make verify` for the TypeScript, package, and JavaScript coverage gates.
Run `make android-test` for the Android bridge unit/coverage gate and
`make ios-test` on macOS for the Swift and Objective-C++ bridge gates.
`make verify-native` combines the JavaScript and available platform-native
checks.

## Release

The package publishes to npm from `v*` tags through GitHub Actions. Configure an npm GitHub Actions trusted publisher for `debugbundle/debugbundle-react-native` and `release.yml`, with a blank environment and direct `npm publish` enabled. Publishing uses OIDC without a long-lived npm token. Make sure the tag matches `package.json` exactly. The 3.1.4 wrapper pins Android 3.1.4 and retains the Swift 3.1.1 minimum and recommends Git 3.1.5 or later within the compatible 3.x CocoaPods line. `make check-protected-native-pins` checks the wrapper, native pins and embedded SDK versions together. Publish only after the exact Android and Swift artifacts are available and their published-consumer checks pass. The release workflow compiles and runs clean apps against those published artifacts on Android API 37 and Xcode 27 before npm publication.

Probe and context native calls share the event bridge's pending count and byte limits, including reserved exception capacity. Saturated auxiliary calls are discarded without evaluating probe suppliers. Probe labels are limited to 128 characters. Persistent JS context retains at most 50 fields with keys up to 128 characters, and field-sensitive privacy runs before local retention and native handoff. Throwing capture context accessors are withheld without escaping into application code. The native 3.x SDKs perform queue persistence on their bounded background workers; abrupt process termination before persistence completes can lose admitted events.

Version 3 defers optional `beforeSend` callbacks until capture returns. Callbacks run on the JavaScript event loop and must return promptly. Pending preparation and native delivery share bounded count/byte limits; valid expanded replacements may be dropped under pressure. See [the version3 migration guide](MIGRATION-3.0.md).

## Probe checkpoint guidance

Application instrumentation supplies probe labels and bounded data. Deploy a new
checkpoint before activating it. Remote activation affects future matching calls
when policy permits; it does not inject code or recover unretained measurements.
Built-in runtime/error/device collectors keep their documented SDK settings.

Use fixed labels and allowlisted technical states: `media.preview.checkpoint`
(stage/input kind/attempt), `auth.session.checkpoint` (observed session presence
and result), `job.dependency.checkpoint` (named dependency/attempt/result), or
`cache.preview.checkpoint` (hit/miss/coarse age bucket). Omit customer identifiers,
tokens/cookies, cache keys, URLs and raw payloads. HTTP 200 or attempt completion
alone does not establish semantic recovery.

Empty probe data means no matching retained observation for the selected sample
window. It does not confirm activation delivery to every SDK or execution of a
label. Check the deployed SDK/wrapper version, instrumentation, scope, expiry,
policy, sampling and delivery receipts. See the [probe recipes](https://debugbundle.com/docs/probes#bounded-checkpoint-recipes).

`make evidence-performance` compares 20 identical native JS error/recovery pairs
with evidence disabled/enabled and an empty/full low-priority bridge queue. It uses
built SDK modules, a held in-memory bridge, network-disabled Docker and Node/V8.
Ordinary timing runs are separate from allocation-sampled runs; the latter retain
major/minor-GC-collected samples and report estimated allocation, not exact byte
counts. Heap deltas, SDK-owned bytes and diagnostic budgets are reported separately.
Setup and error creation are excluded; all original failures, two-node causes and
queue release are checked. The [V8 protocol](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json)
defines sampling semantics. These facade measurements do not establish Hermes,
Android ART or actual native bridge performance; the native qualification lanes
remain separate.


<a id="unreleased-acceptance-credential-privacy"></a>

### Acceptance-credential privacy

The SDK scrubs standalone `dbundle_invite_`,
`dbundle_org_invite_` and `dbundle_org_transfer_` acceptance secrets before
SDK-owned retention or transmission. See the [shared qualification record](https://github.com/debugbundle/debugbundle/blob/main/spec/business-credential-redaction.md).
Existing installations receive this protection when upgraded to a version that includes it.

### Hook size limits

A hook replacement whose optional exception evidence exceeds the combined 32 KiB
UTF-8 JSON budget keeps its replacement message and other primary fields. The SDK
omits the oversized optional evidence and its typed reference, recording
`context.evidence_limits`. Ordinary custom context remains intact. A size limit
must not restore text removed by the hook; an otherwise valid replacement that
cannot fit later ownership or transport limits is withheld. Malformed returns and
throwing hooks retain the established protected-original fallback.

### Internal SDK diagnostics

Internal SDK failures do not use a separate maintainer-reporting channel. The JavaScript and native bridges keep their existing silent handling; local native status diagnostics inherit the Swift/Android implementation. Qualify the coordinated native dependency before release, including Swift's bounded safe rejection codes; wrapper tests with native stubs alone do not prove the installed native dependency.
