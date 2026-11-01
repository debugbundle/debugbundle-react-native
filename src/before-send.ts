import type { DebugBundleBeforeSend, DebugBundleEventEnvelope } from "./types.js";
import { canonicalEvent } from "./evidence-wire.js";
import { EventValidationUnavailable, ownJSON } from "./owned-json.js";

export function applyBeforeSend(event: DebugBundleEventEnvelope, hook: DebugBundleBeforeSend | null): DebugBundleEventEnvelope | null {
  if (!hook) return event;
  try {
    const result = hook(JSON.parse(JSON.stringify(event)) as DebugBundleEventEnvelope);
    if (result instanceof Promise) { void result.catch(() => undefined); return event; }
    if (result === null) return null;
    const owned = ownJSON(result);
    return canonicalEvent(owned) ? owned as unknown as DebugBundleEventEnvelope : event;
  } catch (error) { return error instanceof EventValidationUnavailable ? null : event; }
}
