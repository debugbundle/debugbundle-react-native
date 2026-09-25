# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [3.0.0] - 2026-09-25

### Changed

- Bound pending native probe and context calls with the shared event bridge budgets, contain throwing capture context accessors, and sanitize context field names before retaining or handing off values. Context keeps at most 50 fields with 128-character keys; saturated probes and context updates are best-effort drops.

- Reject locally disabled or below-threshold logs and disabled request capture before JavaScript context redaction and `beforeSend`; filtered console records skip argument formatting when the SDK client exposes its eligibility check.
- Limit unresolved native bridge event calls to 256 and 4 MiB, with 32 calls and 1 MiB reserved for errors and exceptions. Individual retained events are capped at 64 KiB; calls above capacity are discarded so a stalled bridge cannot retain an unbounded promise backlog.

## [2.0.0] - 2026-09-21

### Security

- Enforce mandatory JavaScript capture protection before and after `beforeSend` and before native bridge calls, including the legacy bridge fallback.

### Changed

- Pin the protected Android 2.0.0 and Swift 2.0 release lines and fail the release when any wrapper, bridge, podspec, Android, or smoke-test version drifts.
- Require published-native Android 17/API 37.0 and Xcode 27/iOS 27 app-delivery gates before npm publication.

## [1.3.0] - 2026-09-12

### Changed

- License first-party SDK code under Apache-2.0 and ship consistent package licensing metadata and license text.
- Use Android1.3.1 with complete packaged Apache licenses and the Apache-2.0 Swift SDK1.3.0.
- Publish npm releases through GitHub Actions trusted publishing without an npm token.

## 1.2.0 - 2026-07-29

- Preserve React Native SDK identity, original JavaScript error fields, service, correlation, context, probes, and mobile metadata through additive Android and Swift external-event APIs.
- Compose JavaScript request observations with native capture policy, remote probes, trigger tokens, queue/transport/redaction settings, headers, sampling, and probe configuration.
- Normalize integer-valued JavaScript numbers recursively at the Android bridge so native request capture policy and integer envelope fields retain their canonical types.
- Added the universal `beforeSend` hook, a committed npm lockfile, frozen installs, npm/pnpm/Yarn clean-package smokes, Android/iOS runtime delivery lanes, and Expo development-build verification.
- Coordinate native Android artifacts explicitly during clean Android and Expo builds so source validation never resolves an unrelated published native version.
- Resolve native modules through Metro-visible React Native imports, provide the generated iOS TurboModule implementation for New Architecture apps, preserve scalar context through an object-safe additive bridge, and retain merged app context on canonical request envelopes.
- Added a real RN 0.85 New Architecture iOS simulator smoke that verifies exception and failed-request delivery through the packed npm package, native Swift queue, and HTTP ingestion acknowledgement.
- Prepare the coordinated `1.2.0` source line with Android/Swift `1.2` requirements, enforce per-file TypeScript coverage, and block npm publication until clean Android and iOS apps compile against the published native artifacts.
- Add bare React Native 0.85 Android and Expo SDK 57 / React Native 0.86 Android end-to-end build verification, including consumer-safe Kotlin metadata validation.
- Add repository-local Android Java, Swift, and Objective-C++ wrapper tests and
  enforce at least 80% line coverage for every handwritten native bridge
  source in Make and CI.
- Preserve React Native 0.76 New Architecture codegen discovery by exporting
  package metadata, accept both generated iOS header layouts, and give
  unaccelerated Android runtime smokes enough time and diagnostics to
  distinguish slow startup from bridge or ingestion failures.
- Preserve the legacy arbitrary-value Android `setContext` bridge through
  React Native's New Architecture-compatible `Dynamic` type so module parsing
  cannot crash the host process before initialization.

## 1.1.0

- Added path-scoped immediate client-error promotion while retaining context-only handling for unpromoted client errors.

## 1.0.0

- Declared the React Native Android/iOS package line stable.
