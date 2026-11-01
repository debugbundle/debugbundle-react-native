import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebugBundleClient } from "../src/client.js";
import { createRecordingNativeModule, installRecordingNativeModule, resetDebugBundleNativeModule } from "../src/testing.js";

const proof = { version: 1, features: ["exception_evidence_v1", "resource_observations_v1", "recovery_v1", "evidence_provenance_v1"] };
const failureRef = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
describe("mobile JS evidence through the existing bridge", () => {
  afterEach(resetDebugBundleNativeModule);
  it("prefers the lossless JSON carrier and preserves nullable evidence through native conversion", async () => {
    const native = createRecordingNativeModule({ status: "healthy", evidenceCapabilities: proof });
    const wire: string[] = [];
    const objectCarrier = vi.spyOn(native, "enqueueCanonicalEvent");
    Object.assign(native, { enqueueCanonicalEventJson: (value: string) => { wire.push(value); return true; } });
    installRecordingNativeModule(native);
    const client = createDebugBundleClient({ projectToken: "fictional" });
    client.captureException(new Error("nullable native event"));
    await client.flush();
    expect(objectCarrier).not.toHaveBeenCalled();
    expect(wire).toHaveLength(1);
    expect(JSON.parse(wire[0]!).payload.exception_evidence.nodes[0]).toHaveProperty("stack");
    expect(JSON.parse(wire[0]!).payload.exception_evidence).toHaveProperty("unavailable_reason");
  });
  it("keeps a compatible primary and disables context when the native path is unproven", async () => {
    const native = installRecordingNativeModule();
    const client = createDebugBundleClient({ projectToken: "fictional", captureRecoveryObservations: true });
    client.captureException(new Error("primary", { cause: new Error("cause") }));
    client.captureRecovery({ failureRef, attemptId, state: "attempt_completed", evidenceScope: { kind: "operation", operation_id: failureRef } });
    await client.flush();
    expect(native.events).toHaveLength(1);
    expect(native.events[0]?.payload.message).toBe("primary");
    expect(native.events[0]?.payload).not.toHaveProperty("exception_evidence");
  });
  it("preserves fresh scope, honest JS graph and independent explicit completion", async () => {
    const native = installRecordingNativeModule(createRecordingNativeModule({ status: "healthy", evidenceCapabilities: proof }));
    const client = createDebugBundleClient({ projectToken: "fictional", captureRecoveryObservations: true });
    const scope = client.beginOperation();
    client.captureException(new Error("primary"), { failureRef, trace_id: "trace", session_id: "0" });
    client.captureRecovery({ failureRef, attemptId, state: "attempt_completed", statusCode: 200,
      correlation: { trace_id: "trace", session_id: "0" } });
    scope.close();
    await client.flush();
    expect(native.events).toHaveLength(2);
    const [failure, observation] = native.events;
    expect(failure?.payload.exception_evidence).toMatchObject({ version: 1, runtime: "react_native", root_id: 0 });
    expect(failure?.context?.evidence_reference).toMatchObject({ failure_ref: failureRef, scope: scope.evidenceScope });
    expect(observation?.event_type).toBe("diagnostic_context");
    expect(observation?.payload).toMatchObject({ state: "attempt_completed", status_code: 200, scope: scope.evidenceScope });
    expect(observation?.correlation?.session_id).toBe("0");
  });
  it("does not invoke cause getters or aggregate iterators without a native safe brand", async () => {
    const native = installRecordingNativeModule(createRecordingNativeModule({ status: "healthy", evidenceCapabilities: proof }));
    const client = createDebugBundleClient({ projectToken: "fictional" });
    let calls = 0;
    const error = new Error("primary");
    Object.defineProperty(error, "cause", { get() { calls++; return error; } });
    client.captureException(error);
    await client.flush();
    expect(calls).toBe(0);
    expect(native.events[0]?.payload.message).toBe("primary");
  });
  it("hydrates unchanged native device placeholders while retaining explicit hook metadata", async () => {
    const native = installRecordingNativeModule(createRecordingNativeModule({ status: "healthy", evidenceCapabilities: proof }));
    const unchanged = createDebugBundleClient({ projectToken: "fictional", beforeSend(event) {
      event.payload.device = Object.fromEntries(Object.entries(event.payload.device as object).reverse()); return event;
    } });
    unchanged.captureException(new Error("native hydration")); await unchanged.flush();
    expect(native.events[0]?.payload).not.toHaveProperty("device");
    const changed = createDebugBundleClient({ projectToken: "fictional", beforeSend(event) {
      (event.payload.device as Record<string, unknown>).model = "application-provided"; return event;
    } });
    changed.captureException(new Error("custom device")); await changed.flush();
    expect(native.events[1]?.payload.device).toMatchObject({ model: "application-provided" });
    const device = installRecordingNativeModule(createRecordingNativeModule({ status: "healthy", evidenceCapabilities: proof, device: { model: "native-model" } }));
    const known = createDebugBundleClient({ projectToken: "fictional" }); known.captureException(new Error("known native device")); await known.flush();
    expect(device.events[0]?.payload.device).toMatchObject({ model: "native-model" });
  });
  it("closes implicit scopes at synchronous return, retains explicit async ownership and keeps application errors", async () => {
    const native = installRecordingNativeModule(createRecordingNativeModule({ status: "healthy", evidenceCapabilities: proof }));
    const client = createDebugBundleClient({ projectToken: "fictional", captureRecoveryObservations: true });
    const thrown = new Error("application");
    expect(() => client.withOperationContext(() => { throw thrown; })).toThrow(thrown);
    await client.withOperationContext(async scope => {
      await Promise.resolve();
      client.captureRecovery({ failureRef, attemptId, state: "attempt_completed" });
      client.captureRecovery({ failureRef, attemptId, evidenceScope: scope.evidenceScope, state: "attempt_completed" });
    });
    await client.flush(); expect(native.events).toHaveLength(1);
    client.init({ projectToken: "fictional", captureRecoveryObservations: false });
    client.captureRecovery({ failureRef, attemptId, evidenceScope: { kind: "operation", operation_id: failureRef }, state: "recovery_observed" });
    await client.flush(); expect(native.events).toHaveLength(1);
  });
  it("drops a queued diagnostic after hook-time expiry and a native proof downgrade", async () => {
    const native = installRecordingNativeModule(createRecordingNativeModule({ status: "healthy", evidenceCapabilities: proof }));
    const client = createDebugBundleClient({ projectToken: "fictional", captureRecoveryObservations: true,
      beforeSend(event) { if (event.event_type === "diagnostic_context") event.occurred_at = new Date(Date.parse(event.occurred_at) + 301_000).toISOString(); return event; } });
    const scope = client.beginOperation();
    client.captureException(new Error("primary"), { failureRef }); await client.flush();
    client.captureRecovery({ failureRef, attemptId, state: "attempt_completed" }); await client.flush();
    expect(native.events.map(event => event.event_type)).toEqual(["frontend_exception"]);
    scope.close();
    let downgrade = false;
    native.getStatus = () => ({ status: "healthy", evidenceCapabilities: downgrade ? { version: 1, features: [] } : proof });
    client.init({ projectToken: "fictional", captureRecoveryObservations: true, beforeSend(event) { return event; } });
    downgrade = true; await client.flush();
    client.captureException(new Error("compatible")); await client.flush();
    expect(native.events.at(-1)?.payload).not.toHaveProperty("exception_evidence");
  });
  it("keeps the global fatal path hook-free with a smaller graph", async () => {
    const native = installRecordingNativeModule(createRecordingNativeModule({ status: "healthy", evidenceCapabilities: proof }));
    const hook = vi.fn(event => event);
    const client = createDebugBundleClient({ projectToken: "fictional", beforeSend: hook });
    client.captureException(new Error("fatal"), { source: "react-native-global-error", fatal: true });
    await client.flush(); expect(hook).not.toHaveBeenCalled();
    expect(native.events[0]?.payload.message).toBe("fatal");
    const graph = native.events[0]?.payload.exception_evidence as { nodes: unknown[] };
    expect(graph.nodes.length).toBeLessThanOrEqual(2);
    expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(3584);
  });
});
