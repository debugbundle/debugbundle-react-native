export type EvidenceFeature = "exception_evidence_v1" | "resource_observations_v1" | "recovery_v1" | "evidence_provenance_v1";
export interface EvidenceCapabilities { version: 1; features: EvidenceFeature[] }
export type EvidenceScope = { kind: "operation"; operation_id: string } | { kind: "page"; page_id: string };
export interface OperationScope { readonly operationId: string; readonly evidenceScope: EvidenceScope; close(): void }
export interface RecoveryObservation {
  failureRef: string;
  evidenceScope?: EvidenceScope;
  attemptId: string;
  state: "attempt_started" | "attempt_completed" | "attempt_failed" | "recovery_observed" | "failure_persisted";
  operation?: string;
  statusCode?: number;
  durationMs?: number;
  correlation?: { request_id?: string | null; trace_id?: string | null; session_id?: string | null; user_id_hash?: string | null };
}
