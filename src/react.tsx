import * as React from "react";
import { DebugBundle } from "./index.js";
import type { DebugBundleClient } from "./types.js";

export interface DebugBundleErrorBoundaryProps {
  children: React.ReactNode;
  client?: DebugBundleClient;
  fallback?: React.ReactNode | ((error: Error) => React.ReactNode);
  context?: Record<string, unknown>;
  rethrow?: boolean;
}

interface DebugBundleErrorBoundaryState {
  error: Error | null;
}

export class DebugBundleErrorBoundary extends React.Component<
  DebugBundleErrorBoundaryProps,
  DebugBundleErrorBoundaryState
> {
  state: DebugBundleErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): DebugBundleErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const client = this.props.client ?? DebugBundle;
    client.captureException(error, {
      ...this.props.context,
      component_stack: info.componentStack,
      source: "react-error-boundary"
    });
    if (this.props.rethrow) {
      throw error;
    }
  }

  render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    if (typeof this.props.fallback === "function") {
      return this.props.fallback(this.state.error);
    }
    return this.props.fallback ?? null;
  }
}

export function useDebugBundleAction(
  actionName: string,
  client: DebugBundleClient = DebugBundle
): (data?: Record<string, unknown>) => void {
  return (data?: Record<string, unknown>) => {
    client.recordBreadcrumb("action", {
      action_name: actionName,
      ...(data ?? {})
    });
  };
}
