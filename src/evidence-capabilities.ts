import { ownJSON, jsonObject } from "./owned-json.js";
import type { EvidenceCapabilities, EvidenceFeature } from "./evidence-types.js";

export const EVIDENCE_FEATURES: EvidenceFeature[] = ["exception_evidence_v1", "resource_observations_v1", "recovery_v1", "evidence_provenance_v1"];
export function normalizeCapabilities(value: unknown): EvidenceCapabilities {
  try {
    const descriptor = jsonObject(ownJSON(value));
    if (!descriptor || Object.keys(descriptor).length !== 2 || descriptor.version !== 1 || !Array.isArray(descriptor.features) ||
      descriptor.features.length > 4 || new Set(descriptor.features).size !== descriptor.features.length ||
      descriptor.features.some(item => !EVIDENCE_FEATURES.includes(item as EvidenceFeature))) return { version: 1, features: [] };
    return { version: 1, features: EVIDENCE_FEATURES.filter(feature => (descriptor.features as unknown[]).includes(feature)) };
  } catch { return { version: 1, features: [] }; }
}

export function intersectCapabilities(hops: unknown[]): EvidenceCapabilities {
  if (!hops.length || hops.length > 8) return { version: 1, features: [] };
  const descriptors = hops.map(normalizeCapabilities);
  return { version: 1, features: EVIDENCE_FEATURES.filter(feature => descriptors.every(hop => hop.features.includes(feature))) };
}
