import { errorField, safeErrorStack, nativeBrand } from "./safe-error-fields.js";
import { sanitizeValue } from "./redaction.js";
import { utf8Bytes } from "./owned-json.js";

type LegacyError = { name: string; message: string; stack: string; traceAvailable?: boolean };
type Frame = { function: string | null; file: string | null; line: number | null; column: number | null; classification: "unknown" | "framework" | "sdk" };
type Node = { id: number; name: string; message: string; stack: string | null; trace_origin: string; parsing_status: string;
  frames: Frame[]; relationships: Array<{ kind: "cause"; target_id: number }> };
const text = (value: unknown, fallback: string): string => typeof value === "string" && value ? value : fallback;
export function snapshotError(error: unknown, fields: string[]): LegacyError {
  let name = "Error", message = "Unknown error", stack: unknown;
  try {
    if (typeof error === "string") message = error;
    else if (error !== null && typeof error === "object") {
      name = text(errorField(error, "name"), name); message = text(errorField(error, "message"), message); stack = safeErrorStack(error);
    }
  } catch { /* Legacy outer evidence is best effort; no application accessor is required. */ }
  return {
    name: text(sanitizeValue(name, { redactFields: fields }), "Error"),
    message: text(sanitizeValue(message, { redactFields: fields }), "Unknown error"),
    stack: text(sanitizeValue(text(stack, `${name}: ${message}`), { redactFields: fields, maxStringLength: 8192 }), `${name}: ${message}`),
    traceAvailable: typeof stack === "string" && stack.length > 0
  };
}

function clip(text: string, maximum: number): string {
  let result = "", bytes = 0;
  for (const character of text.slice(0, maximum)) {
    const cost = utf8Bytes(character); if (bytes + cost > maximum) break;
    result += character; bytes += cost;
  }
  return result;
}
export function parseMobileStack(stack: string, maximum = 32): { frames: Frame[]; status: string; truncated: boolean } {
  const frames: Frame[] = [];
  const lines = stack.slice(0, 16_384).split(/\r?\n/, 129);
  let partial = false, truncated = stack.length > 16_384 || lines.length > 128;
  for (const input of lines.slice(0, 128)) {
    if (frames.length >= maximum) { truncated = true; break; }
    if (input.length > 2048) truncated = true;
    const line = input.trim().slice(0, 2048);
    const named = /^at\s+(.+?)\s*\((?:address at )?(.+?):(\d+)(?::(\d+))?\)$/.exec(line);
    const anonymous = named ? null : /^at\s+(.+?):(\d+)(?::(\d+))?$/.exec(line);
    const webkit = named || anonymous ? null : /^(.*?)@(.+?):(\d+)(?::(\d+))?$/.exec(line);
    const match = named ?? anonymous ?? webkit;
    if (!match) { if (/^at\s|@\S+:\d/.test(line)) partial = true; continue; }
    let file = named || webkit ? match[2]! : match[1]!;
    if (/^https?:\/\//i.test(file)) {
      try { const url = new URL(file); file = `${url.protocol}//${url.host}${url.pathname}`; } catch { partial = true; continue; }
    } else file = file.split(/[?#]/, 1)[0]!;
    const row = Number(named || webkit ? match[3] : match[2]);
    const rawColumn = named || webkit ? match[4] : match[3];
    const column = rawColumn === undefined ? null : Number(rawColumn);
    if (!Number.isSafeInteger(row) || row <= 0 || column !== null && (!Number.isSafeInteger(column) || column < 0)) { partial = true; continue; }
    const fn = named || webkit ? clip(match[1]!.trim(), 256) || null : null;
    frames.push({ function: fn, file: clip(file, 2048), line: row, column,
      classification: /node_modules[/\\]@debugbundle[/\\]/.test(file) ? "sdk" : /node_modules[/\\]/.test(file) ? "framework" : "unknown" });
  }
  return { frames, status: truncated ? "truncated" : !frames.length ? "unparsed" : partial ? "partial" : "parsed", truncated };
}

function stackLinks(stack: string): string {
  return stack.replace(/https?:\/\/[^\s)]+/gi, source => {
    const coordinate = /(:\d+(?::\d+)?)$/.exec(source)?.[1] ?? "";
    const location = coordinate ? source.slice(0, -coordinate.length) : source;
    try { const url = new URL(location); return `${url.protocol}//${url.host}${url.pathname}${coordinate}`; } catch { return "[unavailable URL]"; }
  });
}

/** New cause traversal requires the engine's native Error brand. Hermes/JSC
 * without it retain the outer error and explicitly report unsupported traversal.
 * Portable JS cannot prove aggregate arrays are not proxies: no iterator is run. */
export function snapshotExceptionEvidence(error: unknown, legacy: LegacyError, fields: string[], fatal = false,
  brand = nativeBrand): Record<string, unknown> | undefined {
  const nodes: Node[] = [], seen = new Map<object, number>(), active = new Set<object>();
  let unsupported = brand === undefined, unsafe = false, truncated = false, totalFrames = 0;
  const visit = (value: unknown, depth: number, root = false): number | null => {
    if (!root && (!brand || !brand(value))) { unsupported = true; return null; }
    if (typeof value === "object" && value !== null && active.has(value)) { truncated = true; return null; }
    if (depth > (fatal ? 1 : 4) || nodes.length >= (fatal ? 2 : 8)) { truncated = true; return null; }
    if (!root && seen.has(value as object)) return seen.get(value as object)!;
    const snapshot = root ? legacy : snapshotError(value, fields);
    const name = clip(snapshot.name, 256), message = clip(snapshot.message, fatal ? 512 : 2048);
    const stack = stackLinks(clip(snapshot.stack, fatal ? 512 : 16_384));
    const parsed = parseMobileStack(stack, fatal ? Math.min(4, 8 - totalFrames) : 32), frames = parsed.frames;
    totalFrames += frames.length; truncated ||= parsed.truncated;
    const trace = snapshot.traceAvailable !== false;
    const id = nodes.length;
    const node: Node = { id, name, message, stack: trace ? stack : null, frames: trace ? frames : [],
      trace_origin: trace ? "runtime_reported" : "unavailable", parsing_status: trace ? parsed.status : "unavailable", relationships: [] };
    nodes.push(node);
    if (!brand || !brand(value)) { unsupported = true; return id; }
    seen.set(value as object, id); active.add(value as object);
    const cause = Object.getOwnPropertyDescriptor(value, "cause");
    if (cause && !("value" in cause)) unsafe = true;
    else if (cause?.value !== undefined) { const target = visit(cause.value, depth + 1); if (target !== null) node.relationships.push({ kind: "cause", target_id: target }); }
    const aggregate = Object.getOwnPropertyDescriptor(value, "errors");
    if (aggregate) { if (!("value" in aggregate)) unsafe = true; else unsupported = true; }
    active.delete(value as object); return id;
  };
  try { visit(error, 0, true); } catch { unsafe = true; }
  if (!nodes.length) return undefined;
  const graph = { version: 1, runtime: "react_native", root_id: 0, nodes, truncated,
    unavailable_reason: unsafe ? "unsafe" : truncated ? "budget_exceeded" : unsupported ? "unsupported" : null };
  const maximum = fatal ? 3584 : 31_000;
  if (utf8Bytes(JSON.stringify(graph)) > maximum) {
    graph.truncated = true; graph.unavailable_reason = "budget_exceeded";
    for (const node of nodes) { node.stack = null; node.frames = node.frames.slice(0, fatal ? 2 : 4); node.parsing_status = "truncated"; }
  }
  if (utf8Bytes(JSON.stringify(graph)) > maximum) for (const node of nodes) node.frames = [];
  return utf8Bytes(JSON.stringify(graph)) <= maximum ? graph : undefined;
}
