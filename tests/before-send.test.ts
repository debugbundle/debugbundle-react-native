import { describe, expect, it } from "vitest";
import { applyBeforeSend } from "../src/before-send.js";
import type { DebugBundleEventEnvelope } from "../src/types.js";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ACTIVATION_ID = "00000000-0000-4000-8000-000000000002";
const OCCURRED_AT = "2026-07-27T12:00:00.000Z";

function event(
  eventType: DebugBundleEventEnvelope["event_type"] = "frontend_exception",
  payload: Record<string, unknown> = {
    name: "Error",
    message: "boom",
    stack: "Error: boom",
    breadcrumbs: [],
    probe_data: {}
  }
): DebugBundleEventEnvelope {
  return {
    schema_version: "2026-03-01",
    event_id: EVENT_ID,
    event_type: eventType,
    sdk_name: "@debugbundle/sdk-react-native",
    sdk_version: "1.1.0",
    service: {
      name: "mobile",
      environment: "test",
      runtime: "react-native",
      framework: "react-native"
    },
    occurred_at: OCCURRED_AT,
    payload
  };
}

describe("beforeSend event validation", () => {
  it("returns the original event without a hook and isolates hook mutation", () => {
    const original = event();
    expect(applyBeforeSend(original, null)).toBe(original);

    const result = applyBeforeSend(original, (candidate) => {
      candidate.context = { accepted: true };
      return candidate;
    });

    expect(result?.context).toEqual({ accepted: true });
    expect(original).not.toHaveProperty("context");
  });

  it("accepts every canonical payload family", () => {
    const cases: Array<DebugBundleEventEnvelope> = [
      event(),
      event("frontend_breadcrumb", { breadcrumb_type: "screen", data: {} }),
      event("log_event", { level: "warning", message: "slow", attributes: {} }),
      event("request_event", {
        method: "GET",
        path: "/orders",
        query: {},
        headers: {},
        response_status: 503,
        duration_ms: 12,
        response_headers: {}
      }),
      event("error_suppressed", {
        fingerprint: "fingerprint",
        suppressed_count: 0,
        window_seconds: 60,
        first_seen: OCCURRED_AT,
        last_seen: OCCURRED_AT
      }),
      event("probe_event", {
        label: "checkout.state",
        data: {},
        activation_id: null,
        probe_label_pattern: "checkout.*"
      }),
      event("probe_event", {
        label: "checkout.state",
        data: {},
        activation_id: ACTIVATION_ID,
        probe_label_pattern: "checkout.*"
      })
    ];

    for (const original of cases) {
      const result = applyBeforeSend(original, (candidate) => ({
        ...candidate,
        context: { accepted: candidate.event_type }
      }));
      expect(result?.context).toEqual({ accepted: original.event_type });
    }
  });

  it("fails open to the original event for invalid root envelopes", () => {
    const original = event();
    const invalid: unknown[] = [
      [],
      { ...original, extra: true },
      { ...original, schema_version: "legacy" },
      { ...original, event_id: "invalid" },
      { ...original, event_type: "unknown" },
      { ...original, sdk_name: "other" },
      { ...original, sdk_version: "" },
      { ...original, occurred_at: "not-a-date" },
      { ...original, service: [] },
      { ...original, service: { ...original.service, name: "" } },
      { ...original, service: { ...original.service, environment: "" } },
      { ...original, service: { ...original.service, runtime: "browser" } },
      { ...original, service: { ...original.service, framework: "expo" } },
      { ...original, payload: [] }
    ];

    for (const candidate of invalid) {
      expect(applyBeforeSend(original, () => candidate as never)).toBe(original);
    }
    expect(applyBeforeSend(original, () => null)).toBeNull();
  });

  it("rejects missing, unknown, and malformed payload fields for every event family", () => {
    const cases: Array<[DebugBundleEventEnvelope, Record<string, unknown>]> = [
      [event(), { name: "", message: "boom", stack: "stack" }],
      [event(), { name: "Error", message: "", stack: "stack" }],
      [event(), { name: "Error", message: "boom", stack: "" }],
      [event(), { name: "Error", message: "boom", stack: "stack", breadcrumbs: {} }],
      [event(), { name: "Error", message: "boom", stack: "stack", probe_data: [] }],
      [event("frontend_breadcrumb"), { breadcrumb_type: "", data: {} }],
      [event("frontend_breadcrumb"), { breadcrumb_type: "screen", data: [] }],
      [event("log_event"), { level: "", message: "slow", attributes: {} }],
      [event("log_event"), { level: "warning", message: "", attributes: {} }],
      [event("log_event"), { level: "warning", message: "slow", attributes: [] }],
      [event("request_event"), {
        method: "",
        path: "/orders",
        query: {},
        headers: {},
        response_status: 200,
        duration_ms: 1
      }],
      [event("request_event"), {
        method: "GET",
        path: "",
        query: {},
        headers: {},
        response_status: 200,
        duration_ms: 1
      }],
      [event("request_event"), {
        method: "GET",
        path: "/",
        query: [],
        headers: {},
        response_status: 200,
        duration_ms: 1
      }],
      [event("request_event"), {
        method: "GET",
        path: "/",
        query: {},
        headers: [],
        response_status: 200,
        duration_ms: 1
      }],
      [event("request_event"), {
        method: "GET",
        path: "/",
        query: {},
        headers: {},
        response_status: -1,
        duration_ms: 1
      }],
      [event("request_event"), {
        method: "GET",
        path: "/",
        query: {},
        headers: {},
        response_status: 200,
        duration_ms: -1
      }],
      [event("request_event"), {
        method: "GET",
        path: "/",
        query: {},
        headers: {},
        response_status: 200,
        duration_ms: 1,
        response_headers: []
      }],
      [event("error_suppressed"), {
        fingerprint: "",
        suppressed_count: 0,
        window_seconds: 60,
        first_seen: OCCURRED_AT,
        last_seen: OCCURRED_AT
      }],
      [event("error_suppressed"), {
        fingerprint: "fp",
        suppressed_count: -1,
        window_seconds: 60,
        first_seen: OCCURRED_AT,
        last_seen: OCCURRED_AT
      }],
      [event("error_suppressed"), {
        fingerprint: "fp",
        suppressed_count: 1.5,
        window_seconds: 60,
        first_seen: OCCURRED_AT,
        last_seen: OCCURRED_AT
      }],
      [event("error_suppressed"), {
        fingerprint: "fp",
        suppressed_count: 1,
        window_seconds: 0,
        first_seen: OCCURRED_AT,
        last_seen: OCCURRED_AT
      }],
      [event("error_suppressed"), {
        fingerprint: "fp",
        suppressed_count: 1,
        window_seconds: 1.5,
        first_seen: OCCURRED_AT,
        last_seen: OCCURRED_AT
      }],
      [event("error_suppressed"), {
        fingerprint: "fp",
        suppressed_count: 1,
        window_seconds: 60,
        first_seen: "invalid",
        last_seen: OCCURRED_AT
      }],
      [event("error_suppressed"), {
        fingerprint: "fp",
        suppressed_count: 1,
        window_seconds: 60,
        first_seen: OCCURRED_AT,
        last_seen: "invalid"
      }],
      [event("probe_event"), {
        label: "",
        data: {},
        activation_id: null,
        probe_label_pattern: "checkout.*"
      }],
      [event("probe_event"), {
        label: "checkout",
        data: {},
        activation_id: null,
        probe_label_pattern: ""
      }],
      [event("probe_event"), {
        label: "checkout",
        data: [],
        activation_id: null,
        probe_label_pattern: "checkout.*"
      }],
      [event("probe_event"), {
        label: "checkout",
        data: {},
        activation_id: "invalid",
        probe_label_pattern: "checkout.*"
      }]
    ];

    for (const [original, payload] of cases) {
      expect(applyBeforeSend(original, (candidate) => ({ ...candidate, payload }))).toBe(original);
    }

    const missingRequired = event("log_event", {
      level: "warning",
      message: "slow",
      attributes: {}
    });
    expect(applyBeforeSend(missingRequired, (candidate) => ({
      ...candidate,
      payload: { level: "warning", message: "slow" }
    }))).toBe(missingRequired);
    expect(applyBeforeSend(missingRequired, (candidate) => ({
      ...candidate,
      payload: { ...candidate.payload, unknown: true }
    }))).toBe(missingRequired);
  });
});
