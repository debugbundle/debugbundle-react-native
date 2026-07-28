import { describe, expect, it, vi } from "vitest";
import { createDebugBundleNavigationRef, onDebugBundleNavigationReady, onDebugBundleNavigationStateChange } from "../src/navigation.js";

describe("navigation helpers", () => {
  it("records sanitized screen transitions", () => {
    const client = { recordScreen: vi.fn() };
    const ref = createDebugBundleNavigationRef();
    let route = "Checkout Home";
    ref.getCurrentRoute = () => ({ name: route });

    onDebugBundleNavigationReady(ref, client as never);
    route = "Payment/Card";
    onDebugBundleNavigationStateChange(ref, client as never);

    expect(client.recordScreen).toHaveBeenCalledWith("Checkout_Home", null, "react-navigation");
    expect(client.recordScreen).toHaveBeenCalledWith("Payment/Card", "Checkout_Home", "react-navigation");
  });

  it("ignores missing and repeated routes", () => {
    const client = { recordScreen: vi.fn() };
    const ref = createDebugBundleNavigationRef();

    onDebugBundleNavigationReady(ref, client as never);
    onDebugBundleNavigationStateChange(ref, client as never);
    expect(client.recordScreen).not.toHaveBeenCalled();

    ref.getCurrentRoute = () => ({ name: "Orders" });
    onDebugBundleNavigationReady(ref, client as never);
    onDebugBundleNavigationStateChange(ref, client as never);
    expect(client.recordScreen).toHaveBeenCalledOnce();
  });
});
