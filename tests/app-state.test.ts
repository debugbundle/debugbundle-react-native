import { describe, expect, it, vi } from "vitest";
import { instrumentDebugBundleAppState } from "../src/app-state.js";
import type { DebugBundleClient } from "../src/types.js";

describe("app state instrumentation", () => {
  it("records transitions, flushes background states, and removes its listener", () => {
    let listener: ((state: string) => void) | undefined;
    const remove = vi.fn();
    const appState = {
      addEventListener(_event: "change", next: (state: string) => void) {
        listener = next;
        return { remove };
      }
    };
    const client = {
      recordBreadcrumb: vi.fn(),
      flush: vi.fn(async () => undefined)
    } as unknown as DebugBundleClient;

    const restore = instrumentDebugBundleAppState(appState, client);
    listener?.("active");
    listener?.("background");
    listener?.("inactive");
    restore();

    expect(client.recordBreadcrumb).toHaveBeenCalledTimes(3);
    expect(client.recordBreadcrumb).toHaveBeenCalledWith("app_state", { state: "active" });
    expect(client.flush).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledOnce();
  });
});
