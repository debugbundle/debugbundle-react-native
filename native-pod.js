// Resolve the native SDK without requiring a new CocoaPods Trunk catalogue entry.
export const swiftNativeVersion = "3.1.2";
export const swiftPodDeclaration = `pod 'DebugBundle', :git => 'https://github.com/debugbundle/debugbundle-swift.git', :tag => 'v${swiftNativeVersion}'`;

export function withNativePodSource(contents) {
  // An explicit consumer declaration owns its source and version constraints.
  if (/^\s*pod\s+['"]DebugBundle['"]/m.test(contents)) return contents;
  const target = /^([ \t]*)target\s+(['"])[^'"\n]+\2\s+do[ \t]*$/m;
  if (!target.test(contents)) throw new Error("DebugBundle requires a CocoaPods target to configure its native Git source");
  return contents.replace(target, (line, indent) => `${line}\n${indent}  ${swiftPodDeclaration}`);
}
