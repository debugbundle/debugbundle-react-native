// swift-tools-version: 6.0

import PackageDescription

let package = Package(
	name: "DebugBundleReactNativeNativeTests",
	platforms: [
		.macOS(.v13)
	],
	products: [
		.library(
			name: "DebugBundleReactNativeBridge",
			targets: ["DebugBundleReactNativeBridge"]
		)
	],
	targets: [
		.target(
			name: "React",
			path: "native-tests/ios/React"
		),
		.target(
			name: "DebugBundle",
			path: "native-tests/ios/DebugBundle"
		),
		.target(
			name: "DebugBundleReactNativeBridge",
			dependencies: ["React", "DebugBundle"],
			path: "ios",
			exclude: ["DebugBundleReactNativeBridge.mm"]
		),
		.testTarget(
			name: "DebugBundleReactNativeBridgeTests",
			dependencies: ["DebugBundleReactNativeBridge", "DebugBundle"],
			path: "native-tests/ios/Tests"
		)
	],
	swiftLanguageModes: [.v5]
)
