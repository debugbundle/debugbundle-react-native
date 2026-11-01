import { types } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMobileStack, snapshotError, snapshotExceptionEvidence } from "../src/exception-evidence.js";
import { canonicalEvent } from "../src/evidence-wire.js";
import { ownJSON } from "../src/owned-json.js";

const stack = "Error: failure\n    at checkout (address at index.android.bundle:12:3)\n    at /app/index.js:4:0\nrender@https://user:password@example.test/main.js?secret=value#hash:8:2";
const evidence = (error: unknown, fatal = false) => snapshotExceptionEvidence(error, snapshotError(error, []), [], fatal, types.isNativeError)!;
function errorWithStack(message = "failure", text = stack): Error {
  return Object.defineProperty(new Error(message), "stack", { value: text, configurable: true });
}
function accepted(graph: unknown): boolean {
  return canonicalEvent(ownJSON({ schema_version: "2026-03-01", event_id: "11111111-1111-4111-8111-111111111111",
    event_type: "backend_exception", sdk_name: "@debugbundle/sdk-react-native", sdk_version: "3.1.0",
    occurred_at: "2026-10-28T00:00:00.000Z", service: { name: "mobile", environment: "test" },
    payload: { name: "Error", message: "failure", stack: "outer", handled: true,
      request: { method: "UNKNOWN", path: "/", query: {}, headers: {} }, response: { status_code: 0 }, runtime: { version: "fixture" }, exception_evidence: graph } }));
}
describe("mobile native error evidence", () => {
  const runnerFormatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  const runnerLimit = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
  beforeEach(() => {
    // Vitest installs an application formatter; ordinary engine-stack fixtures
    // need the native defaults. The hostile formatter case installs its own.
    Object.defineProperty(Error, "prepareStackTrace", { configurable: true, value: undefined });
    Object.defineProperty(Error, "stackTraceLimit", { configurable: true, value: 10 });
  });
  afterEach(() => {
    if (runnerFormatter) Object.defineProperty(Error, "prepareStackTrace", runnerFormatter); else Reflect.deleteProperty(Error, "prepareStackTrace");
    if (runnerLimit) Object.defineProperty(Error, "stackTraceLimit", runnerLimit); else Reflect.deleteProperty(Error, "stackTraceLimit");
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  it("reads Hermes, V8 and JSC locations without exposing URL credentials, query or fragments", () => {
    const parsed = parseMobileStack(stack);
    expect(parsed.status).toBe("parsed");
    expect(parsed.frames).toEqual([
      { function: "checkout", file: "index.android.bundle", line: 12, column: 3, classification: "unknown" },
      { function: null, file: "/app/index.js", line: 4, column: 0, classification: "unknown" },
      { function: "render", file: "https://example.test/main.js", line: 8, column: 2, classification: "unknown" }
    ]);
    const graph = evidence(errorWithStack());
    expect(accepted(graph)).toBe(true);
    expect(JSON.stringify(graph)).not.toContain("secret=value");
    expect(JSON.stringify(graph)).not.toContain("user:password");
  });
  it("retains unknown text and distinguishes partial, absent and truncated stacks", () => {
    expect(parseMobileStack("unrecognized runtime text")).toMatchObject({ frames: [], status: "unparsed", truncated: false });
    const partial = parseMobileStack("at native\nat /app:3\nat https://[:3:2\nat /bad:0:1\nat /bad:99999999999999999:1\nat /bad:1:99999999999999999");
    expect(partial).toMatchObject({ status: "partial", frames: [{ file: "/app", line: 3, column: null }] });
    expect(parseMobileStack("at /node_modules/@debugbundle/sdk/index.js:3:1\nat fn (/node_modules/react/index.js:2:1)").frames.map(f => f.classification)).toEqual(["sdk", "framework"]);
    for (const text of ["at /app:1:2\n".repeat(140), "x".repeat(17_000), `at ${"a".repeat(2100)}:1:2`]) {
      expect(parseMobileStack(text)).toMatchObject({ status: "truncated", truncated: true });
    }
    const unknown = evidence(errorWithStack("message", "unrecognized runtime text"));
    expect(unknown.nodes).toMatchObject([{ stack: "unrecognized runtime text", parsing_status: "unparsed", trace_origin: "runtime_reported" }]);
    const absent = evidence({ message: "plain" });
    expect(absent.nodes).toMatchObject([{ stack: null, frames: [], trace_origin: "unavailable", parsing_status: "unavailable" }]);
  });
  it("collects safe native causes, reports unsupported aggregates and bounds cycles and depth", () => {
    const child = errorWithStack("child");
    const parent = new Error("parent", { cause: child });
    const graph = evidence(parent);
    expect(graph.nodes).toMatchObject([{ relationships: [{ kind: "cause", target_id: 1 }] }, { message: "child" }]);
    expect(graph.unavailable_reason).toBeNull(); expect(accepted(graph)).toBe(true);
    Object.defineProperty(child, "cause", { value: parent });
    expect(evidence(parent)).toMatchObject({ truncated: true, unavailable_reason: "budget_exceeded" });
    let chain = new Error("leaf");
    for (let i = 0; i < 7; i++) chain = new Error("parent", { cause: chain });
    expect(evidence(chain)).toMatchObject({ truncated: true, unavailable_reason: "budget_exceeded" });
    expect(evidence(chain).nodes).toHaveLength(5);
    expect(evidence(new AggregateError([new Error("child")], "group"))).toMatchObject({ unavailable_reason: "unsupported" });
    expect(evidence(new Error("outer", { cause: { message: "foreign" } }))).toMatchObject({ unavailable_reason: "unsupported" });
  });
  it("never executes error accessors, aggregate iterators or stack formatters", () => {
    let calls = 0;
    const hostile = () => { calls++; throw new Error("application accessor"); };
    for (const key of ["cause", "errors"]) {
      const error = Object.defineProperty(new Error("outer"), key, { get: hostile });
      expect(evidence(error)).toMatchObject({ unavailable_reason: "unsafe" });
    }
    const aggregate = Object.defineProperty(new Error("outer"), "errors", { value: { [Symbol.iterator]: hostile } });
    expect(evidence(aggregate)).toMatchObject({ unavailable_reason: "unsupported" });
    for (const key of ["name", "message", "stack"]) {
      const error = Object.defineProperty(new Error("outer"), key, { get: hostile });
      expect(snapshotError(error, []).traceAvailable).toBe(false);
    }
    const originalFormatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    try {
      Object.defineProperty(Error, "prepareStackTrace", { configurable: true, value: hostile });
      expect(snapshotError(new Error("outer"), []).traceAvailable).toBe(false);
    } finally { if (originalFormatter) Object.defineProperty(Error, "prepareStackTrace", originalFormatter); else Reflect.deleteProperty(Error, "prepareStackTrace"); }
    const originalLimit = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit")!;
    try {
      Object.defineProperty(Error, "stackTraceLimit", { configurable: true, get: hostile });
      expect(snapshotError(errorWithStack(), []).traceAvailable).toBe(false);
    } finally { Object.defineProperty(Error, "stackTraceLimit", originalLimit); }
    expect(calls).toBe(0);
  });
  it("uses honest fallback for unknown values and custom prototypes and contains descriptor failures", () => {
    expect(snapshotError("plain failure", [])).toMatchObject({ name: "Error", message: "plain failure", traceAvailable: false });
    expect(snapshotError(null, [])).toMatchObject({ message: "Unknown error", traceAvailable: false });
    expect(snapshotError({ name: 42, message: true }, [])).toMatchObject({ name: "Error", message: "Unknown error" });
    class Custom extends Error { get name() { throw new Error("unsafe"); } }
    expect(snapshotError(new Custom("message"), []).traceAvailable).toBe(false);
    const error = errorWithStack();
    const proto = Object.create(Error.prototype, { message: { get() { throw new Error("unsafe"); } } });
    Object.setPrototypeOf(error, proto);
    expect(snapshotError(error, []).traceAvailable).toBe(false);
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("no descriptors"); } });
    expect(snapshotError(proxy, [])).toMatchObject({ message: "Unknown error" });
    expect(snapshotExceptionEvidence(errorWithStack(), snapshotError("safe", []), [], false, () => { throw new Error("unavailable brand"); }))
      .toMatchObject({ unavailable_reason: "unsafe" });
  });
  it("uses smaller fatal evidence and preserves valid UTF-8 bounds under large native stacks", () => {
    let error = errorWithStack("😀".repeat(2048), `at ${"😀".repeat(200)} (/app:3:2)\n`.repeat(32));
    for (let i = 0; i < 4; i++) error = Object.defineProperty(errorWithStack("😀".repeat(2048), stack.repeat(100)), "cause", { value: error });
    const graph = evidence(error), fatal = evidence(error, true);
    expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(31_000); expect(accepted(graph)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(fatal))).toBeLessThanOrEqual(3584); expect(accepted(fatal)).toBe(true);
    expect((fatal.nodes as Array<{ frames: unknown[] }>).reduce((sum, node) => sum + node.frames.length, 0)).toBeLessThanOrEqual(8);
    expect((fatal.nodes as unknown[]).length).toBeLessThanOrEqual(2);
  });
});
