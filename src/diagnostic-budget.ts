import type { DebugBundleEventEnvelope } from "./types.js";
import { evidenceReference } from "./evidence-wire.js";
import { utf8Bytes } from "./owned-json.js";

interface Window { startsAt: number; failureAt: number | null; failureId: string | null; attempts: Set<string>; observations: number;
  resource: boolean; ambiguous: boolean; pending: number }
interface Pending { key: string; bytes: number; attempt: string | null; kind: string }
const cost = (value: unknown): number => utf8Bytes(JSON.stringify(value));
function scopeKey(event: DebugBundleEventEnvelope, reference: Record<string, unknown>): string {
  const scope = reference.scope as Record<string, unknown>;
  return JSON.stringify([event.service.name, event.service.environment, event.correlation?.trace_id ?? null,
    event.correlation?.session_id ?? null, reference.failure_ref, [scope.kind, scope.operation_id ?? scope.page_id]]);
}
/** Bridge ownership lasts until its promise settles; native offline ownership then
 * remains with the native SDK. Observation/attempt allowances are never refunded. */
export class MobileDiagnosticBudget {
  private windows = new Map<string, Window>();
  private pending = new Map<string, Pending>();
  get accountedBytes(): number {
    let bytes = 0;
    for (const [key, window] of this.windows) bytes += cost([key, { ...window, attempts: [...window.attempts] }]);
    for (const [id, pending] of this.pending) bytes += pending.bytes + cost([id, pending.key, pending.attempt, pending.kind]);
    return bytes;
  }
  private prune(now: number): void {
    for (const [key, window] of this.windows) if (!window.pending && now >= window.startsAt + 300_000) this.windows.delete(key);
  }
  register(event: DebugBundleEventEnvelope): void {
    const reference = event.context?.evidence_reference;
    if (!evidenceReference(reference)) return;
    const now = Date.parse(event.occurred_at); if (!Number.isFinite(now)) return;
    this.prune(now);
    const key = scopeKey(event, reference as Record<string, unknown>), previous = this.windows.get(key);
    if (!previous && this.windows.size >= 50) return;
    const next = { ...(previous ?? this.fresh(now)), failureAt: previous?.failureAt ?? now, failureId: event.event_id };
    if (previous?.failureId && previous.failureId !== event.event_id) next.ambiguous = true;
    this.windows.set(key, next);
    if (this.accountedBytes > 65_536) { if (previous) this.windows.set(key, previous); else this.windows.delete(key); }
  }
  reserve(event: DebugBundleEventEnvelope, owner = event.event_id): boolean {
    const now = Date.parse(event.occurred_at);
    if (!Number.isFinite(now) || this.pending.has(owner)) return false;
    this.prune(now);
    const payload = event.payload, key = scopeKey(event, payload), previous = this.windows.get(key);
    if (!previous && this.windows.size >= 50 || previous?.ambiguous) return false;
    const next = { ...(previous ?? this.fresh(now)), attempts: new Set(previous?.attempts), pending: (previous?.pending ?? 0) + 1 };
    if (now < (next.failureAt ?? next.startsAt) || now > (next.failureAt ?? next.startsAt) + 300_000 || next.observations >= 20) return false;
    const attempt = payload.kind === "recovery" ? String(payload.attempt_id) : null;
    if (attempt !== null) { if (!next.attempts.has(attempt) && next.attempts.size >= 5) return false; next.attempts.add(attempt); }
    else {
      if (next.resource || next.failureId !== payload.source_event_id || next.failureAt === null || now > next.failureAt + 30_000) return false;
      next.resource = true;
    }
    next.observations++;
    this.windows.set(key, next);
    this.pending.set(owner, { key, attempt, kind: String(payload.kind), bytes: cost(event) });
    if (this.accountedBytes > 65_536) {
      this.pending.delete(owner);
      if (previous) this.windows.set(key, previous); else this.windows.delete(key);
      return false;
    }
    return true;
  }
  replace(owner: string, event: DebugBundleEventEnvelope): boolean {
    const current = this.pending.get(owner), payload = event.payload, key = scopeKey(event, payload);
    const attempt = payload.kind === "recovery" ? String(payload.attempt_id) : null;
    if (!current || current.key !== key || current.attempt !== attempt || current.kind !== payload.kind) {
      this.release(owner); return this.reserve(event, owner);
    }
    // Hook identity may stay stable while occurrence time or resource identity
    // changes. Revalidate association without spending another observation.
    const window = this.windows.get(key), now = Date.parse(event.occurred_at);
    if (!window || window.ambiguous || !Number.isFinite(now) ||
      now < (window.failureAt ?? window.startsAt) || now > (window.failureAt ?? window.startsAt) + 300_000 ||
      attempt === null && (window.failureAt === null || payload.source_event_id !== window.failureId || now > window.failureAt + 30_000)) {
      this.release(owner); return false;
    }
    const previous = current.bytes;
    current.bytes = cost(event);
    if (this.accountedBytes > 65_536) { current.bytes = previous; this.release(owner); return false; }
    return true;
  }
  release(id: string): void {
    const pending = this.pending.get(id); if (!pending) return;
    this.pending.delete(id);
    const window = this.windows.get(pending.key); if (window) window.pending = Math.max(0, window.pending - 1);
  }
  clear(): void { this.windows.clear(); this.pending.clear(); }
  private fresh(now: number): Window { return { startsAt: now, failureAt: null, failureId: null, attempts: new Set(), observations: 0, resource: false, ambiguous: false, pending: 0 }; }
}
