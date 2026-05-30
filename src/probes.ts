import { DebugBundle } from "./index.js";
import type { DebugBundleClient, DebugBundleProbeOptions } from "./types.js";

export function probe(label: string, data: unknown | (() => unknown), options?: DebugBundleProbeOptions): void {
  DebugBundle.probe(label, data, options);
}

export function activateDebugBundleProbeTrigger(token: string, client: DebugBundleClient = DebugBundle): boolean {
  void client.activateProbeTriggerToken(token);
  return Boolean(token);
}
