import { describe, expect, it } from "vitest";
// @ts-expect-error The packaged Expo helper executes directly without compilation.
import { swiftNativeVersion, swiftPodDeclaration, withNativePodSource } from "../native-pod.js";

describe("native CocoaPods Git source", () => {
  it("configures bare and Expo targets once without relying on Trunk", () => {
    for (const quote of ["'", '"']) {
      const source = `platform :ios, '15.0'\n  target ${quote}App${quote} do\n    use_expo_modules!\n  end\n`;
      const patched = withNativePodSource(source);
      expect(patched).toContain(`    ${swiftPodDeclaration}`);
      expect(patched).toContain(`:tag => 'v${swiftNativeVersion}'`);
      expect(withNativePodSource(patched)).toBe(patched);
    }
  });
  it("preserves explicit consumer sources and ignores comments", () => {
    const explicit = "target 'App' do\n  pod 'DebugBundle', :path => '../native'\nend\n";
    expect(withNativePodSource(explicit)).toBe(explicit);
    expect(withNativePodSource("# pod 'DebugBundle'\ntarget 'App' do\nend")).toContain(swiftPodDeclaration);
  });
  it("fails clearly for an unsupported Podfile", () => {
    expect(() => withNativePodSource("platform :ios, '15.0'\n")).toThrow("CocoaPods target");
  });
});
