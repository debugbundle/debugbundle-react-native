import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyBeforeSend } from "../src/before-send.js";
import type { DebugBundleEventEnvelope } from "../src/types.js";
import { canonicalEvent } from "../src/evidence-wire.js";
import { EventValidationUnavailable, ownJSON, utf8Bytes } from "../src/owned-json.js";

const corpus = JSON.parse(readFileSync(new URL("./fixtures/evidence-wire-cases.json", import.meta.url), "utf8"));
const original = structuredClone(corpus.events.find((item: { valid: boolean }) => item.valid).event) as DebugBundleEventEnvelope;

describe("canonical native JS hook ownership", () => {
  it("owns mutable plain JSON without invoking getters or foreign formatters", () => {
    const input = { array: [{ value: "original" }], alias: { value: 1 } };
    const owned = ownJSON(input);
    input.array[0]!.value = "changed";
    expect(owned).toEqual({ array: [{ value: "original" }], alias: { value: 1 } });
    let calls = 0;
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { calls++; return "unsafe"; } });
    expect(() => ownJSON(accessor)).toThrow(TypeError);
    const array = Object.defineProperty([], "0", { enumerable: true, get() { calls++; return "unsafe"; } });
    expect(() => ownJSON(array)).toThrow(TypeError);
    expect(calls).toBe(0);
    expect(() => ownJSON(new Date())).toThrow(TypeError);
    expect(() => ownJSON(undefined)).toThrow(TypeError);
    expect(() => ownJSON(Number.NaN)).toThrow(TypeError);
    const cyclic: unknown[] = []; cyclic.push(cyclic);
    expect(() => ownJSON(cyclic)).toThrow(TypeError);
    const shared = { value: true };
    expect(ownJSON({ a: shared, b: shared })).toEqual({ a: shared, b: shared });
    expect(Object.hasOwn(ownJSON(JSON.parse('{"__proto__":{"safe":true}}'))!, "__proto__")).toBe(true);
  });

  it("withholds exhausted hook ownership instead of restoring pre-hook data", () => {
    for (const fixture of corpus.json_sizes) expect(utf8Bytes(JSON.stringify(fixture.value))).toBe(fixture.bytes);
    for (const value of ["😀", "\ud800", "\udc00", "\ud800A", "a\u0080\u0800"]) expect(utf8Bytes(value)).toBe(Buffer.byteLength(value));
    const huge = "x".repeat(8 * 1024 * 1024 + 1);
    for (const value of [huge, { [huge]: null }, Array(257).fill(null),
      Object.fromEntries(Array.from({ length: 257 }, (_, i) => [String(i), null])), Array.from({ length: 256 }, () => Array(17).fill(null))]) {
      expect(() => ownJSON(value)).toThrow(EventValidationUnavailable);
    }
    let deep: unknown = null;
    for (let index = 0; index < 18; index++) deep = [deep];
    expect(() => ownJSON(deep)).toThrow(EventValidationUnavailable);
    expect(applyBeforeSend(original, () => ({ ...original, context: { huge } }))).toBeNull();
  });

  it("matches the accepting schema and semantic decisions for the full shared corpus", () => {
    for (const fixture of corpus.events) expect(canonicalEvent(ownJSON(fixture.event)), fixture.id).toBe(fixture.valid);
  });
  it("retains every allowed canonical replacement across SDK identities and event kinds", () => {
    for (const fixture of corpus.events.filter((item: { valid: boolean }) => item.valid)) {
      expect(applyBeforeSend(original, () => fixture.event), fixture.id).toEqual(fixture.event);
    }
  });

  it("does not erase invalid nested evidence into a successful legacy replacement", () => {
    const valid = structuredClone(corpus.events.find((item: { valid: boolean; event: { event_type: string } }) =>
      item.valid && item.event.event_type === "frontend_exception").event);
    const invalid = { ...valid, sdk_name: "@debugbundle/sdk-react-native", service: {
      ...valid.service, runtime: "react-native", framework: "react-native"
    }, payload: { ...valid.payload, breadcrumbs: [{ invalid: true }] } };
    expect(applyBeforeSend(original, () => invalid)).toEqual(original);
  });
});
