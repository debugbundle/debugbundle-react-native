import { canonicalShape } from "./canonical-schema.js";
import { jsonObject, utf8Bytes, type OwnedJSON } from "./owned-json.js";

export function freshReference(value: unknown): value is string {
  return typeof value === "string" && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value);
}
export function evidenceScope(value: unknown): boolean {
  const scope = jsonObject(value);
  if (!scope || !["operation", "page"].includes(String(scope.kind))) return false;
  const key = scope.kind === "page" ? "page_id" : "operation_id";
  return Object.keys(scope).length === 2 && freshReference(scope[key]);
}
export function evidenceReference(value: unknown): boolean {
  const ref = jsonObject(value);
  return ref !== null && Object.keys(ref).length === 3 && ref.version === 1 && freshReference(ref.failure_ref) && evidenceScope(ref.scope);
}
const fits = (value: OwnedJSON | undefined, maximum: number): boolean => value === null ||
  typeof value === "string" && value.length <= maximum && utf8Bytes(value) <= maximum;
const size = (value: unknown): number => utf8Bytes(JSON.stringify(value));

function graph(value: OwnedJSON): boolean {
  const graph = jsonObject(value)!;
  const nodes = graph.nodes as Array<Record<string, OwnedJSON>>;
  const edges = new Map<number, Array<Record<string, OwnedJSON>>>();
  for (const node of nodes) {
    const id = node.id as number;
    if (edges.has(id) || !fits(node.name, 256) || !fits(node.message, 2048) || !fits(node.stack, 16_384)) return false;
    for (const frame of node.frames as Array<Record<string, OwnedJSON>>) if (!fits(frame.function, 256) || !fits(frame.file, 2048)) return false;
    edges.set(id, node.relationships as Array<Record<string, OwnedJSON>>);
  }
  for (const children of edges.values()) {
    const seen = new Set<string>(); let causes = 0;
    for (const child of children) {
      const identity = `${child.kind}:${child.target_id}`;
      if (!edges.has(child.target_id as number) || seen.has(identity)) return false;
      seen.add(identity);
      if (child.kind === "cause" || child.kind === "context") causes++;
    }
    if (causes > 1) return false;
  }
  const active = new Set<number>(), reached = new Set<number>();
  const visit = (id: number, depth: number): boolean => {
    if (depth > 4 || active.has(id) || !edges.has(id)) return false;
    active.add(id); reached.add(id);
    for (const child of edges.get(id)!) if (!visit(child.target_id as number, depth + 1)) return false;
    active.delete(id); return true;
  };
  return visit(graph.root_id as number, 0) && reached.size === nodes.length && size(value) <= 32_768;
}

function resourceURL(value: string): boolean {
  if (!value || utf8Bytes(value) > 2048 || /[\u0000-\u0020\u007f\\?#]/.test(value) || value.startsWith("//")) return false;
  if (value.startsWith("/")) return true;
  if (!/^https?:\/\//i.test(value)) return false;
  try { const url = new URL(value); return !!url.hostname && !url.username && !url.password; } catch { return false; }
}
function resources(value: OwnedJSON): boolean {
  const entries = jsonObject(value)!.items as Array<Record<string, OwnedJSON>>;
  for (const entry of entries) {
    if (entry.kind === "csp" && (typeof entry.effective_directive !== "string" ||
      !/^[a-z-]{1,64}$/.test(entry.effective_directive))) return false;
    if (entry.source_url !== null && !resourceURL(entry.source_url as string)) return false;
  }
  return size(value) <= 32_768;
}

/** Semantic refinements accompany the generated schema, as in every native SDK. */
export function canonicalEvent(value: OwnedJSON): boolean {
  if (!canonicalShape(value)) return false;
  const event = jsonObject(value)!, payload = jsonObject(event.payload)!;
  const type = event.event_type;
  if (type === "frontend_exception") {
    const mobile = ["@debugbundle/sdk-swift", "@debugbundle/sdk-android", "@debugbundle/sdk-react-native"].includes(event.sdk_name as string);
    if (!jsonObject(payload[mobile ? "device" : "browser"])) return false;
  }
  if (type === "diagnostic_context") {
    if (!freshReference(payload.failure_ref) || !evidenceScope(payload.scope)) return false;
    if (payload.kind === "recovery") {
      if (!freshReference(payload.attempt_id) || payload.operation !== undefined && !fits(payload.operation, 64)) return false;
    } else if (!resources(payload.observations!)) return false;
    if (jsonObject(payload.scope)?.kind === "page") {
      const session = jsonObject(event.correlation)?.session_id;
      if (typeof session !== "string" || !session.trim()) return false;
    }
    return true;
  }
  const additions: Record<string, OwnedJSON> = {};
  for (const field of ["exception_evidence", "execution", "resource_observations"]) {
    const item = payload[field];
    if (item === undefined) continue;
    if (!(type === "backend_exception" && field !== "resource_observations" || type === "frontend_exception" && field !== "execution")) return false;
    if (field === "exception_evidence" && !graph(item) || field === "execution" && !fits(jsonObject(item)?.name, 128) ||
      field === "resource_observations" && !resources(item)) return false;
    additions[field] = item;
  }
  if (!Object.keys(additions).length) return true;
  const ref = jsonObject(event.context)?.evidence_reference;
  if (evidenceReference(ref)) additions.evidence_reference = ref!;
  return size(additions) <= 32_768;
}
