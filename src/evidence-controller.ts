import type { DebugBundleEventEnvelope, ResolvedDebugBundleConfig, NativeDebugBundleState } from "./types.js";
import type { EvidenceCapabilities, EvidenceFeature, EvidenceScope, OperationScope, RecoveryObservation } from "./evidence-types.js";
import { intersectCapabilities, normalizeCapabilities } from "./evidence-capabilities.js";
import { MobileDiagnosticBudget } from "./diagnostic-budget.js";
import { evidenceReference, evidenceScope, freshReference } from "./evidence-wire.js";
import { ownJSON, jsonObject, utf8Bytes } from "./owned-json.js";
import { generateId } from "./client-values.js";

interface Lease { id: string; ended: boolean; parent: Lease | null }
export class MobileEvidenceController {
  readonly budget = new MobileDiagnosticBudget();
  private current: Lease | null = null;
  private ended = false;
  constructor(private config: ResolvedDebugBundleConfig) {}
  close(): void { this.ended = true; this.current = null; this.budget.clear(); }
  private active(lease: Lease | null): boolean {
    let depth = 0;
    for (let item = lease; item; item = item.parent) if (item.ended || ++depth > 32 || this.ended) return false;
    return lease !== null && !this.ended;
  }
  begin(): OperationScope {
    let depth = 0;
    for (let item = this.current; item; item = item.parent) depth++;
    const lease: Lease = { id: generateId(), ended: this.ended || depth >= 32, parent: this.current };
    if (!lease.ended) this.current = lease;
    const evidenceScope: EvidenceScope = { kind: "operation", operation_id: lease.id };
    return { operationId: lease.id, evidenceScope, close: () => {
      lease.ended = true;
      if (this.current === lease) this.current = this.active(lease.parent) ? lease.parent : null;
    } };
  }
  private scope(): EvidenceScope | null { return this.active(this.current) ? { kind: "operation", operation_id: this.current!.id } : null; }
  capabilities(state: NativeDebugBundleState, canonicalBridge: boolean): EvidenceCapabilities {
    // A JS pin cannot assert that an old native binary preserves fields it never implemented.
    if (!canonicalBridge || this.ended) return { version: 1, features: [] };
    const native = normalizeCapabilities(state.evidenceCapabilities);
    const proof = this.config.evidenceCapabilities ? intersectCapabilities([native, this.config.evidenceCapabilities]) : native;
    return { version: 1, features: proof.features.filter(feature =>
      feature !== "exception_evidence_v1" || this.config.captureExceptionEvidence).filter(feature =>
      feature !== "recovery_v1" || this.config.captureRecoveryObservations) };
  }
  supports(feature: EvidenceFeature, state: NativeDebugBundleState, bridge: boolean): boolean {
    return this.capabilities(state, bridge).features.includes(feature);
  }
  context(source: Record<string, unknown>, state: NativeDebugBundleState, bridge: boolean): Record<string, unknown> {
    if (!this.supports("recovery_v1", state, bridge) && !this.supports("resource_observations_v1", state, bridge)) return source;
    try {
      const failure = Object.getOwnPropertyDescriptor(source, "failureRef"), explicit = Object.getOwnPropertyDescriptor(source, "evidenceScope");
      if (!failure || !("value" in failure) || !freshReference(failure.value)) return source;
      const scope = explicit && "value" in explicit ? ownJSON(explicit.value) : this.scope();
      if (!evidenceScope(scope)) return source;
      const result: Record<string, unknown> = { ...source, evidence_reference: { version: 1, failure_ref: failure.value, scope } };
      delete result.failureRef; delete result.evidenceScope;
      return result;
    } catch { return source; }
  }
  recovery(observation: RecoveryObservation): { payload: Record<string, unknown>; correlation: DebugBundleEventEnvelope["correlation"] } | null {
    try {
      const input = jsonObject(ownJSON(observation)); if (!input) return null;
      const scope = input.evidenceScope ?? this.scope();
      if (!freshReference(input.failureRef) || !freshReference(input.attemptId) || !evidenceScope(scope)) return null;
      const payload: Record<string, unknown> = { version: 1, kind: "recovery", failure_ref: input.failureRef,
        scope, attempt_id: input.attemptId, state: input.state };
      for (const [local, wire] of [["operation", "operation"], ["statusCode", "status_code"], ["durationMs", "duration_ms"]] as const) {
        if (input[local] !== undefined) payload[wire] = input[local];
      }
      return { payload, correlation: input.correlation as DebugBundleEventEnvelope["correlation"] };
    } catch { return null; }
  }
  filter(original: DebugBundleEventEnvelope, state: NativeDebugBundleState, bridge: boolean): DebugBundleEventEnvelope | null {
    const proof = this.capabilities(state, bridge).features;
    if (original.event_type === "diagnostic_context") {
      return proof.includes(original.payload.kind === "recovery" ? "recovery_v1" : "resource_observations_v1") ? original : null;
    }
    const event = { ...original, payload: { ...original.payload }, ...(original.context ? { context: { ...original.context } } : {}) };
    if (!proof.includes("exception_evidence_v1")) { delete event.payload.exception_evidence; delete event.payload.execution; }
    if (!proof.includes("resource_observations_v1")) delete event.payload.resource_observations;
    if (!proof.includes("recovery_v1") && !proof.includes("resource_observations_v1") && evidenceReference(event.context?.evidence_reference)) delete event.context!.evidence_reference;
    return event;
  }
}

export function fitMobileEvent(original: DebugBundleEventEnvelope, maximum = 65_536): DebugBundleEventEnvelope | null {
  if (utf8Bytes(JSON.stringify(original)) <= maximum) return original;
  const event = { ...original, payload: { ...original.payload }, ...(original.context ? { context: { ...original.context } } : {}) };
  for (const field of ["exception_evidence", "execution", "resource_observations"]) delete event.payload[field];
  if (evidenceReference(event.context?.evidence_reference)) delete event.context!.evidence_reference;
  return utf8Bytes(JSON.stringify(event)) <= maximum ? event : null;
}
