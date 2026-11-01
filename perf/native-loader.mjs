// Only the host React Native binding is replaced; all SDK modules are built bytes.
export function resolve(specifier, context, nextResolve) {
  if (specifier === "react-native") return {
    url: "data:text/javascript,export const NativeModules = {}; export const TurboModuleRegistry = { get() { return null; } };",
    shortCircuit: true
  };
  return nextResolve(specifier, context);
}
