#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
coverage_root="${repo_root}/.native-coverage"
rm -rf "${coverage_root}"
mkdir -p "${coverage_root}"

cd "${repo_root}"
swift test --enable-code-coverage
swift_report="$(swift test --show-codecov-path)"
node scripts/check-native-coverage.mjs \
	"${swift_report}" \
	"/ios/DebugBundleReactNative.swift"

objc_binary="${coverage_root}/objc-bridge-coverage"
objc_raw_profile="${coverage_root}/objc-bridge.profraw"
objc_profile="${coverage_root}/objc-bridge.profdata"
xcrun --sdk macosx clang++ \
	-std=c++17 \
	-fobjc-arc \
	-fprofile-instr-generate \
	-fcoverage-mapping \
	-framework Foundation \
	-I "${repo_root}/native-tests/ios/objc-stubs" \
	"${repo_root}/native-tests/ios/objc/BridgeCoverageHarness.mm" \
	-o "${objc_binary}"
LLVM_PROFILE_FILE="${objc_raw_profile}" "${objc_binary}"
xcrun llvm-profdata merge -sparse "${objc_raw_profile}" -o "${objc_profile}"
xcrun llvm-cov export \
	"${objc_binary}" \
	-instr-profile "${objc_profile}" \
	-summary-only \
	>"${coverage_root}/objc.json"
node scripts/check-native-coverage.mjs \
	"${coverage_root}/objc.json" \
	"/ios/DebugBundleReactNativeBridge.mm"
