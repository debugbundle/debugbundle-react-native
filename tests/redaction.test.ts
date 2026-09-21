import { describe, expect, it } from "vitest";
import { sanitizeHeaders, sanitizeValue } from "../src/redaction.js";
import fixtures from "./fixtures/privacy-conformance.json";
import { sanitizeTelemetry } from "../src/privacy-telemetry.js";

describe("redaction", () => {
  it("matches sensitive key segments and protects circular objects", () => {
    const value: Record<string, unknown> = { accessToken: "secret", safe: "ok" };
    value.self = value;

    expect(sanitizeValue(value)).toMatchObject({
      accessToken: "[REDACTED]",
      safe: "ok",
      self: "[Circular]"
    });
  });

  it("matches the portable mandatory privacy corpus before bridge retention", () => {
    for (const testCase of fixtures.cases) {
      expect(sanitizeValue(testCase.input), testCase.id).toEqual(testCase.expected);
    }
    expect(sanitizeValue({ password: "canary" }, { redactFields: [] }))
      .toEqual({ password: "[REDACTED]" });
  });

  it("bounds hostile values without exposing an unscanned prefix or throwing into the host", () => {
    expect(sanitizeValue("safe ".repeat(5000))).toBe("[REDACTED]");
    expect(sanitizeTelemetry({ safe: "checkout" }, { additionalKeys: [""] }))
      .toEqual({ ok: false, reason: "unsafe_input" });
    expect(sanitizeTelemetry({ safe: "checkout" }, { maxTotalBytes: 0 }))
      .toEqual({ ok: false, reason: "unsafe_input" });
    expect(sanitizeTelemetry({ safe: "checkout" }, { maxTotalBytes: 3 }))
      .toEqual({ ok: false, reason: "budget_exceeded" });
    expect(sanitizeTelemetry({ unsafe: undefined }).ok).toBe(false);
    const object: Record<string, unknown> = { safe: "checkout" };
    object.self = object;
    expect(sanitizeTelemetry(object)).toMatchObject({
      ok: true, value: { safe: "checkout", self: "[Circular]" }
    });
    const aliased = { safe: "checkout" };
    expect(sanitizeTelemetry({ left: aliased, right: aliased })).toMatchObject({
      ok: true, value: { left: aliased, right: aliased }
    });
    const throwing = Object.defineProperty({}, "password", { enumerable: true, get: () => { throw Error("secret"); } });
    expect(sanitizeValue(throwing)).toBe("[REDACTED]");
    expect(sanitizeTelemetry(Array.from({ length: 257 }, () => "safe"))).toMatchObject({
      ok: true, value: "[REDACTED]"
    });
    const malformed = sanitizeTelemetry("{broken password:SYNTHETIC_SECRET");
    expect(malformed.ok).toBe(true);
    expect(JSON.stringify(malformed)).not.toContain("SYNTHETIC_SECRET");
  });

  it("counts UTF-8 bytes, rejects unsupported values, and protects boundary keys", () => {
    expect(sanitizeTelemetry({ accent: "é", emoji: "😀", lone: "\ud800" }).ok).toBe(true);
    expect(sanitizeTelemetry("é", { maxTotalBytes: 1 })).toEqual({ ok: false, reason: "budget_exceeded" });
    expect(sanitizeTelemetry(undefined)).toEqual({ ok: false, reason: "unsafe_input" });
    expect(sanitizeTelemetry(Number.NaN)).toEqual({ ok: false, reason: "unsafe_input" });
    expect(sanitizeTelemetry(new Date())).toEqual({ ok: false, reason: "unsafe_input" });
    expect(sanitizeTelemetry("safe", { additionalKeys: Array(129).fill("custom") }))
      .toEqual({ ok: false, reason: "unsafe_input" });
    expect(sanitizeTelemetry("safe", { additionalKeys: ["x".repeat(65)] }))
      .toEqual({ ok: false, reason: "unsafe_input" });
    expect(sanitizeTelemetry("safe", { maxTotalBytes: 600 * 1024 }))
      .toEqual({ ok: false, reason: "unsafe_input" });
    const unsafeKey = { "Authorization: Bearer abcdef123456": "checkout", route: "/cart" };
    expect(sanitizeTelemetry(unsafeKey)).toMatchObject({ ok: true, value: { route: "/cart" } });
    const nested: Record<string, unknown> = { route: "/cart" };
    for (let index = 0; index < 20; index += 1) {
      nested.child = { ...nested };
    }
    expect(sanitizeTelemetry(nested).ok).toBe(true);
  });

  it("allowlists safe headers only", () => {
    expect(
      sanitizeHeaders({
        authorization: "secret",
        "x-request-id": "req_1",
        "content-type": "application/json"
      })
    ).toEqual({
      "content-type": "application/json",
      "x-request-id": "req_1"
    });
  });
});
