import { describe, expect, it, vi } from "vitest";
import { DebugBundleErrorBoundary, useDebugBundleAction } from "../src/react.js";
import type { DebugBundleClient } from "../src/types.js";

describe("React helpers", () => {
  it("derives, captures, and renders every error-boundary fallback form", () => {
    const captureException = vi.fn();
    const client = { captureException } as unknown as DebugBundleClient;
    const error = new Error("render failed");
    const boundary = new DebugBundleErrorBoundary({
      children: "child",
      client,
      context: { route: "checkout" },
      fallback: (caught) => `fallback:${caught.message}`
    });

    expect(DebugBundleErrorBoundary.getDerivedStateFromError(error)).toEqual({ error });
    expect(boundary.render()).toBe("child");
    boundary.state = { error };
    boundary.componentDidCatch(error, { componentStack: "\n at Checkout" } as never);
    expect(boundary.render()).toBe("fallback:render failed");
    expect(captureException).toHaveBeenCalledWith(error, {
      route: "checkout",
      component_stack: "\n at Checkout",
      source: "react-error-boundary"
    });

    const nodeFallback = new DebugBundleErrorBoundary({
      children: "child",
      fallback: "static fallback"
    });
    nodeFallback.state = { error };
    expect(nodeFallback.render()).toBe("static fallback");

    const nullFallback = new DebugBundleErrorBoundary({ children: "child" });
    nullFallback.state = { error };
    expect(nullFallback.render()).toBeNull();
  });

  it("supports explicit rethrow and action breadcrumbs with and without data", () => {
    const error = new Error("fatal render");
    const rethrowing = new DebugBundleErrorBoundary({
      children: null,
      client: { captureException: vi.fn() } as unknown as DebugBundleClient,
      rethrow: true
    });
    expect(() => rethrowing.componentDidCatch(error, { componentStack: "" } as never)).toThrow(error);

    const recordBreadcrumb = vi.fn();
    const action = useDebugBundleAction(
      "checkout.submit",
      { recordBreadcrumb } as unknown as DebugBundleClient
    );
    action({ outcome: "success" });
    action();

    expect(recordBreadcrumb).toHaveBeenNthCalledWith(1, "action", {
      action_name: "checkout.submit",
      outcome: "success"
    });
    expect(recordBreadcrumb).toHaveBeenNthCalledWith(2, "action", {
      action_name: "checkout.submit"
    });
  });
});
