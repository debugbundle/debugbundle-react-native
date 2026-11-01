import { describe, expect, it } from "vitest";
import { MobileDiagnosticBudget } from "../src/diagnostic-budget.js";
import type { DebugBundleEventEnvelope } from "../src/types.js";

const reference = "11111111-1111-4111-8111-111111111111";
const scope = { kind: "operation", operation_id: reference };
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 28) + seconds * 1000).toISOString();
function observation(id = "observation", seconds = 1, attempt = "attempt"): DebugBundleEventEnvelope {
  return { schema_version: "2026-03-01", event_id: id, event_type: "diagnostic_context", sdk_name: "react_native", sdk_version: "3.1.0",
    service: { name: "mobile", environment: "test" }, occurred_at: at(seconds), correlation: { trace_id: null, session_id: "0" },
    payload: { version: 1, kind: "recovery", failure_ref: reference, scope, attempt_id: attempt, state: "attempt_started" } };
}
function failure(id = "failure", seconds = 0): DebugBundleEventEnvelope {
  return { ...observation(id, seconds), event_type: "frontend_exception", payload: { name: "Error", message: "primary", stack: "" },
    context: { evidence_reference: { version: 1, failure_ref: reference, scope } } };
}
describe("mobile diagnostic ownership and bounded association", () => {
  it("rechecks hook timestamps and late source identity without refunding allowance", () => {
    const budget = new MobileDiagnosticBudget(); budget.register(failure());
    expect(budget.reserve(observation())).toBe(true);
    expect(budget.replace("observation", observation("changed", 301))).toBe(false);
    expect(budget.reserve(observation("earlier", -1))).toBe(false);
    const late = { ...observation("late", 20), payload: { kind: "resource_observation", failure_ref: reference, scope, source_event_id: "failure" } };
    expect(budget.reserve(late)).toBe(true);
    expect(budget.replace("late", { ...late, payload: { ...late.payload, source_event_id: "different" } })).toBe(false);
    expect(budget.reserve({ ...late, event_id: "second" })).toBe(false);
  });
  it("holds expired windows while pending and never refunds the five attempts or twenty observations", () => {
    const budget = new MobileDiagnosticBudget(); budget.register(failure());
    for (let i = 0; i < 20; i++) {
      const event = observation(`obs-${i}`, 1 + i, `attempt-${i % 5}`);
      expect(budget.reserve(event)).toBe(true);
      if (i) budget.release(event.event_id);
    }
    expect(budget.reserve(observation("over", 21, "attempt-0"))).toBe(false);
    expect(budget.reserve(observation("expired", 301))).toBe(false);
    budget.release("obs-0");
    expect(budget.reserve(observation("fresh", 301))).toBe(true);
    budget.clear();
    for (let i = 0; i < 5; i++) expect(budget.reserve(observation(`new-${i}`, 1, `try-${i}`))).toBe(true);
    expect(budget.reserve(observation("sixth", 1, "new-attempt"))).toBe(false);
    expect(budget.reserve(observation("new-0"))).toBe(false);
  });
  it("isolates service, environment, trace and session and marks duplicate failure identities ambiguous", () => {
    const budget = new MobileDiagnosticBudget(); budget.register(failure()); budget.register(failure());
    expect(budget.reserve(observation())).toBe(true);
    budget.register(failure("different"));
    expect(budget.replace("observation", observation())).toBe(false);
    expect(budget.reserve(observation("ambiguous"))).toBe(false);
    for (const change of [{ service: { name: "other", environment: "test" } },
      { service: { name: "mobile", environment: "other" } }, { correlation: { trace_id: "trace", session_id: "0" } },
      { correlation: { trace_id: null, session_id: "other" } }]) {
      expect(budget.reserve({ ...observation(JSON.stringify(change)), ...change })).toBe(true);
    }
    expect(budget.reserve({ ...observation("invalid"), occurred_at: "invalid" })).toBe(false);
    budget.register({ ...failure(), occurred_at: "invalid" }); budget.register({ ...failure(), context: {} });
  });
  it("allows out-of-order recovery and only one matching resource observation inside thirty seconds", () => {
    const budget = new MobileDiagnosticBudget();
    expect(budget.reserve(observation())).toBe(true); budget.release("observation"); budget.register(failure());
    const late = { ...observation("late", 31), payload: { kind: "resource_observation", failure_ref: reference, scope, source_event_id: "failure" } };
    expect(budget.reserve(late)).toBe(false);
    expect(budget.reserve({ ...late, occurred_at: at(30) })).toBe(true);
    budget.release("late"); expect(budget.reserve({ ...late, occurred_at: at(29) })).toBe(false);
    budget.clear(); expect(budget.reserve(late)).toBe(false);
  });
  it("charges pending bytes and metadata, rolls back overflow and bounds windows", () => {
    const budget = new MobileDiagnosticBudget();
    const huge = { ...observation(), context: { data: "x".repeat(65_536) } };
    expect(budget.reserve(huge)).toBe(false); expect(budget.accountedBytes).toBe(0);
    expect(budget.reserve(observation())).toBe(true);
    expect(budget.replace("observation", huge)).toBe(false);
    expect(budget.accountedBytes).toBeLessThan(65_536);
    for (let i = 0; i < 50; i++) budget.register({ ...failure(), service: { name: `service-${i}`, environment: "test" } });
    expect(budget.reserve({ ...observation("overflow"), service: { name: "new", environment: "test" } })).toBe(false);
    budget.clear(); expect(budget.accountedBytes).toBe(0); budget.release("missing");
    expect(budget.reserve(observation())).toBe(true);
    expect(budget.replace("observation", { ...observation("hook-id"), service: { name: "new", environment: "test" } })).toBe(true);
    budget.release("observation");
    expect(budget.replace("unknown-owner", observation())).toBe(true);
  });
});
