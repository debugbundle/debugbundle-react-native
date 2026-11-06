import { describe, expect, it } from "vitest";
// @ts-expect-error The native fixture helper executes directly without compilation.
import { renderExpoIosRuntimeAppDelegate, renderIosRuntimeAppDelegate } from "../scripts/ios-runtime-lifecycle.mjs";

const expoTemplate = `internal import Expo
import React
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?
  var reactNativeFactory: RCTReactNativeFactory?
  func startup() {
    let factory = ExpoReactNativeFactory(delegate: ReactNativeDelegate())
    reactNativeFactory = factory
#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
  // Linking API
  func linking() { RCTLinkingManager.application(app, open: url, options: options) }
}
class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {}
`;

describe("installed iOS runtime fixture lifecycle", () => {
  it("starts Expo from a scene while preserving its factory, subscribers and linking", () => {
    const result = renderExpoIosRuntimeAppDelegate(expoTemplate);
    expect(result).toContain("class AppDelegate: ExpoAppDelegate");
    expect(result).toContain("ExpoReactNativeFactory(delegate:");
    expect(result).toContain("return super.application(application, didFinishLaunchingWithOptions: launchOptions)");
    expect(result).toContain("RCTLinkingManager.application");
    expect(result).toContain("configuration.delegateClass = SceneDelegate.self");
    expect(result).toContain("UIWindow(windowScene: windowScene)");
    expect(result).toContain("appDelegate.window = window");
    expect(result).toContain('withModuleName: "main"');
    expect(result.match(/factory.startReactNative\(/g)).toHaveLength(1);
    expect(result).not.toContain("UIWindow(frame:");
    expect(renderExpoIosRuntimeAppDelegate(result)).toBe(result);
  });
  it("retains the bare React Native module and scene behaviour", () => {
    const result = renderIosRuntimeAppDelegate("DebugBundleSmoke");
    expect(result).toContain('withModuleName: "DebugBundleSmoke"');
    expect(result).toContain("UIWindow(windowScene: windowScene)");
    expect(result).not.toContain("appDelegate.window = window");
  });
  it("rejects an unrecognised Expo template rather than silently testing no startup", () => {
    expect(() => renderExpoIosRuntimeAppDelegate("class AppDelegate {}"))
      .toThrow("Expo runtime template");
  });
});
