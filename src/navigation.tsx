import { DebugBundle } from "./index.js";
import type { DebugBundleClient } from "./types.js";

export interface DebugBundleNavigationRef {
  current?: unknown;
  getCurrentRoute?: () => { name?: string; key?: string; params?: unknown } | undefined;
}

let previousRouteName: string | null = null;

export function createDebugBundleNavigationRef(): DebugBundleNavigationRef {
  return { current: undefined };
}

export function onDebugBundleNavigationReady(ref: DebugBundleNavigationRef, client: DebugBundleClient = DebugBundle): void {
  previousRouteName = routeName(ref);
  if (previousRouteName) {
    client.recordScreen(previousRouteName, null, "react-navigation");
  }
}

export function onDebugBundleNavigationStateChange(ref: DebugBundleNavigationRef, client: DebugBundleClient = DebugBundle): void {
  const currentRouteName = routeName(ref);
  if (!currentRouteName || currentRouteName === previousRouteName) {
    return;
  }
  client.recordScreen(currentRouteName, previousRouteName, "react-navigation");
  previousRouteName = currentRouteName;
}

function routeName(ref: DebugBundleNavigationRef): string | null {
  const route = ref.getCurrentRoute?.();
  if (!route?.name) {
    return null;
  }
  return route.name.replace(/[^a-zA-Z0-9_.:/-]/g, "_").slice(0, 120);
}
