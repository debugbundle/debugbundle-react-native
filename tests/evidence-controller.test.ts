import { describe, expect, it } from "vitest";
import { intersectCapabilities, normalizeCapabilities, EVIDENCE_FEATURES } from "../src/evidence-capabilities.js";
import { MobileEvidenceController, fitMobileEvent } from "../src/evidence-controller.js";
import { resolveConfig } from "../src/client.js";
import type { DebugBundleEventEnvelope } from "../src/types.js";

const proof = { version: 1, features: EVIDENCE_FEATURES };
const state = { status: "healthy" as const, evidenceCapabilities: proof };
const ref = "11111111-1111-4111-8111-111111111111";
const scope = { kind: "operation" as const, operation_id: ref };
const reference = { version: 1, failure_ref: ref, scope };
const event: DebugBundleEventEnvelope = { schema_version: "1", event_id: ref, event_type: "frontend_exception", sdk_name: "@debugbundle/sdk-react-native",
  sdk_version: "3.1.0", occurred_at: "2026-10-28T00:00:00.000Z", service: { name: "mobile", environment: "test" },
  context: { evidence_reference: reference }, payload: { message: "latest hook primary", exception_evidence: { large: "x".repeat(1000) } } };
describe("mobile complete-path proof and revocable scopes", () => {
  it("fails closed on malformed descriptors and intersects all proven hops in canonical order", () => {
    expect(normalizeCapabilities({ version: 1, features: [...EVIDENCE_FEATURES].reverse() })).toEqual(proof);
    let calls = 0;
    for (const value of [null, [], {}, { version: 2, features: [] }, { version: 1, features: ["future"] },
      { ...proof, extra: true }, { version: 1, features: ["recovery_v1", "recovery_v1"] },
      { version: 1, features: Array(5).fill("recovery_v1") }, Object.defineProperty({}, "version", { enumerable: true, get() { calls++; return 1; } })]) {
      expect(normalizeCapabilities(value).features).toEqual([]);
      expect(intersectCapabilities([proof, value]).features).toEqual([]);
    }
    expect(calls).toBe(0);
    expect(intersectCapabilities([]).features).toEqual([]);
    expect(intersectCapabilities(Array(9).fill(proof)).features).toEqual([]);
    expect(intersectCapabilities(Array(8).fill(proof))).toEqual(proof);
    expect(intersectCapabilities([proof, { version: 1, features: ["recovery_v1"] }]).features).toEqual(["recovery_v1"]);
  });
  it("requires native proof, honours local options and invalidates all leases on close", () => {
    const controller = new MobileEvidenceController(resolveConfig({ evidenceCapabilities: proof, captureExceptionEvidence: false, captureRecoveryObservations: false }));
    expect(controller.capabilities(state, true).features).toEqual(["resource_observations_v1", "evidence_provenance_v1"]);
    expect(controller.capabilities({ status: "healthy" }, true).features).toEqual([]);
    expect(controller.capabilities(state, false).features).toEqual([]);
    controller.begin(); controller.close();
    expect(controller.capabilities(state, true).features).toEqual([]);
    controller.begin().close();
  });
  it("restores nested ownership, revokes children when parents close and bounds nesting", () => {
    const controller = new MobileEvidenceController(resolveConfig({ captureRecoveryObservations: true }));
    const parent = controller.begin(), child = controller.begin();
    expect(controller.context({ failureRef: ref }, state, true)).toMatchObject({ evidence_reference: { scope: child.evidenceScope } });
    child.close(); child.close();
    expect(controller.context({ failureRef: ref }, state, true)).toMatchObject({ evidence_reference: { scope: parent.evidenceScope } });
    const descendant = controller.begin(); parent.close();
    expect(controller.context({ failureRef: ref }, state, true)).toEqual({ failureRef: ref }); descendant.close();
    const leases = Array.from({ length: 34 }, () => controller.begin());
    expect(controller.context({ failureRef: ref }, state, true)).toMatchObject({ evidence_reference: { scope: leases[31]!.evidenceScope } });
    leases.reverse().forEach(lease => lease.close());
    expect(controller.context({ failureRef: ref }, state, true)).toEqual({ failureRef: ref });
  });
  it("owns explicit recovery input and preserves legacy references when typed support is absent", () => {
    const controller = new MobileEvidenceController(resolveConfig({ captureRecoveryObservations: true }));
    const source = { failureRef: ref, evidenceScope: scope, legacy: "retained" };
    expect(controller.context(source, state, true)).toEqual({ evidence_reference: reference, legacy: "retained" });
    expect(controller.context(source, state, false)).toBe(source);
    expect(controller.context({ failureRef: "bad" }, state, true)).toEqual({ failureRef: "bad" });
    expect(controller.context({ failureRef: ref, evidenceScope: new Date() }, state, true)).toHaveProperty("failureRef");
    const input = { failureRef: ref, attemptId: ref, evidenceScope: { ...scope }, state: "attempt_completed" as const,
      statusCode: 200, durationMs: 5, operation: "reload", correlation: { session_id: "0" } };
    const prepared = controller.recovery(input);
    expect(prepared).toMatchObject({ payload: { state: "attempt_completed", status_code: 200, duration_ms: 5, operation: "reload" }, correlation: { session_id: "0" } });
    input.evidenceScope.operation_id = "changed";
    expect(prepared?.payload.scope).toEqual(scope);
    for (const invalid of [null, [], new Date(), { ...input, failureRef: "bad" }, { ...input, attemptId: "bad" }, { ...input, evidenceScope: {} }]) {
      expect(controller.recovery(invalid as never)).toBeNull();
    }
    expect(controller.recovery(Object.defineProperty({}, "failureRef", { enumerable: true, get() { throw new Error("getter"); } }) as never)).toBeNull();
  });
  it("downgrades queued optional data on the latest primary and never restores dropped content", () => {
    const controller = new MobileEvidenceController(resolveConfig({ captureRecoveryObservations: true }));
    expect(controller.filter(event, state, true)).toEqual(event);
    expect(controller.filter(event, { status: "healthy" }, true)).toMatchObject({ context: {}, payload: { message: "latest hook primary" } });
    const legacy = { ...event, context: { evidence_reference: "legacy" } };
    expect(controller.filter(legacy, { status: "healthy" }, true)?.context?.evidence_reference).toBe("legacy");
    for (const kind of ["recovery", "resource_observation"]) {
      const diagnostic = { ...event, event_type: "diagnostic_context" as const, payload: { kind } };
      expect(controller.filter(diagnostic, state, true)).toBe(diagnostic);
      expect(controller.filter(diagnostic, state, false)).toBeNull();
    }
    expect(fitMobileEvent(event)).toBe(event);
    expect(fitMobileEvent(event, 500)).toMatchObject({ payload: { message: "latest hook primary" }, context: {} });
    expect(fitMobileEvent({ ...event, payload: { message: "x".repeat(1000) } }, 500)).toBeNull();
    expect(fitMobileEvent({ ...event, context: { evidence_reference: "legacy" } }, 500)?.context?.evidence_reference).toBe("legacy");
    expect(fitMobileEvent({ ...event, context: undefined } as unknown as DebugBundleEventEnvelope, 500)?.payload).toEqual({ message: "latest hook primary" });
  });
});
