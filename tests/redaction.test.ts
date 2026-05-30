import { describe, expect, it } from "vitest";
import { sanitizeHeaders, sanitizeValue } from "../src/redaction.js";

describe("redaction", () => {
  it("matches sensitive key segments and protects circular objects", () => {
    const value: Record<string, unknown> = { accessToken: "secret", safe: "ok" };
    value.self = value;

    expect(sanitizeValue(value)).toMatchObject({
      accessToken: "[Redacted]",
      safe: "ok",
      self: "[Circular]"
    });
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
