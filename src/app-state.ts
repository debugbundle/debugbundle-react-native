import { DebugBundle } from "./index.js";
import type { DebugBundleClient } from "./types.js";

export interface AppStateLike {
  currentState?: string;
  addEventListener(event: "change", listener: (state: string) => void): { remove: () => void };
}

export function instrumentDebugBundleAppState(appState: AppStateLike, client: DebugBundleClient = DebugBundle): () => void {
  const subscription = appState.addEventListener("change", (state) => {
    client.recordBreadcrumb("app_state", { state });
    if (state === "background" || state === "inactive") {
      void client.flush();
    }
  });
  return () => subscription.remove();
}
