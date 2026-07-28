# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

## 1.2.0 - 2026-07-28

- Preserve React Native SDK identity, original JavaScript error fields, service, correlation, context, probes, and mobile metadata through additive Android and Swift external-event APIs.
- Compose JavaScript request observations with native capture policy, remote probes, trigger tokens, queue/transport/redaction settings, headers, sampling, and probe configuration.
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

## 1.1.0

- Added path-scoped immediate client-error promotion while retaining context-only handling for unpromoted client errors.

## 1.0.0

- Declared the React Native Android/iOS package line stable.
