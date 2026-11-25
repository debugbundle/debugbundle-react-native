import { describe, expect, it } from "vitest";
import { protectEventFields } from "../src/event-privacy.js";
import { sanitizeHeaders, sanitizeValue } from "../src/redaction.js";
import fixtures from "./fixtures/privacy-conformance.json";
import { sanitizeTelemetry } from "../src/privacy-telemetry.js";
import type { DebugBundleEventEnvelope } from "../src/types.js";

describe("redaction", () => {
  it("keeps custom privacy labels literal and isolated across nested documents and URLs", () => {
    for (let index = 0; index < 24; index++) {
      const field = `custom.${index}`;
      const input = {
        text: `${field}=secret customX${index}=visible password=hidden`,
        nested: [{ [field]: "hidden", ordinary: "visible" }],
        url: `https://example.test/path?${field}=hidden&ordinary=visible`
      };
      const safe = sanitizeTelemetry(input, { additionalKeys: [field] });
      expect(safe).toMatchObject({ ok: true, value: {
        text: `${field}=[REDACTED] customX${index}=visible password=[REDACTED]`,
        nested: [{ [field]: "[REDACTED]", ordinary: "visible" }]
      } });
      expect(JSON.stringify(safe)).not.toContain("hidden");
      expect(sanitizeTelemetry(`${field}=visible`)).toMatchObject({ ok: true, value: `${field}=visible` });
    }
  });
  it("bounds cyclic native error causes without invoking accessors or formatters", () => {
    let calls = 0;
    const error = new Error("outer");
    Object.defineProperty(error, "cause", { get() { calls++; return error; } });
    expect(sanitizeValue(error)).toMatchObject({ message: "outer", cause: null });
    expect(calls).toBe(0);
    const cyclic = new Error("cycle");
    Object.defineProperty(cyclic, "cause", { value: cyclic });
    expect(sanitizeValue(cyclic)).toMatchObject({ message: "cycle", cause: "[Circular]" });
    const child = new Error("child");
    expect(sanitizeValue(new Error("parent", { cause: child }))).toMatchObject({ cause: { message: "child" } });
    expect(sanitizeValue(new Error("parent", { cause: child }), { maxDepth: 1 }))
      .toMatchObject({ cause: "[Truncated: depth]" });
  });
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
    expect(sanitizeHeaders({
        authorization: "secret",
        "x-request-id": "req_1",
        "content-type": "application/json"
      })
    ).toEqual({
      "content-type": "application/json",
      "x-request-id": "req_1"
    });
  });

  it("matches all exact_key_cases from the shared privacy conformance corpus and enforces combined bounds", () => {
    for (const testCase of fixtures.exact_key_cases) {
      const result = sanitizeTelemetry(testCase.input, {
        additionalKeys: testCase.additional_keys,
        exactKeys: testCase.exact_keys
      });
      expect(result, testCase.id).toMatchObject({ ok: true, value: testCase.expected });
    }
    expect(
      sanitizeTelemetry("safe", {
        additionalKeys: Array(65).fill("broad"),
        exactKeys: Array(64).fill("exact")
      })
    ).toEqual({ ok: false, reason: "unsafe_input" });
    expect(
      sanitizeValue({ tag: "secret-tag", tag_name: "script" }, { redactExactFields: ["tag"] })
    ).toEqual({ tag: "[REDACTED]", tag_name: "script" });
  });

  it("preserves SEC-23a protocol evidence fields when broad redactFields collide with protocol names", async () => {
    const { createDebugBundleClient } = await import("../src/client.js");
    const { setNativeModuleForTesting } = await import("../src/native.js");
    const canonicalEvents: unknown[] = [];
    const failureRef = "11111111-1111-4111-8111-111111111111";
    const operationId = "22222222-2222-4222-8222-222222222222";
    const attemptId = "33333333-3333-4333-8333-333333333333";

    setNativeModuleForTesting({
      initialize: () => ({
        status: "healthy",
        lastEventAt: null,
        nativeModuleAvailable: true,
        evidenceCapabilities: {
          version: 1,
          features: ["exception_evidence_v1", "recovery_v1", "evidence_provenance_v1"]
        }
      }),
      enqueueEvent: async () => undefined,
      enqueueCanonicalEventJson: async (raw) => {
        canonicalEvents.push(JSON.parse(raw));
        return true;
      },
      flush: async () => undefined,
      getStatus: async () => ({ status: "healthy", lastEventAt: null, nativeModuleAvailable: true }),
      setContext: async () => undefined
    });

    try {
      const client = createDebugBundleClient({
        projectToken: "dbundle_proj_test",
        service: "rn-app",
        environment: "production",
        redactFields: ["tag", "reference", "reason", "file"],
        redactExactFields: ["payout_code"],
        captureRecoveryObservations: true,
        evidenceCapabilities: {
          version: 1,
          features: ["exception_evidence_v1", "recovery_v1", "evidence_provenance_v1"]
        }
      });

      client.captureException(new Error("Checkout failed"), {
        failureRef,
        evidenceScope: { kind: "operation", operation_id: operationId },
        payout: {
          tag: "secret-tag",
          reference: "secret-ref",
          reason: "secret-reason",
          file: "secret-file",
          payout_code: "secret-code",
          payout_code_label: "visible-label"
        }
      });
      client.captureRecovery({
        failureRef,
        attemptId,
        evidenceScope: { kind: "operation", operation_id: operationId },
        state: "recovery_observed",
        statusCode: 200
      });
      await client.flush();

      const exceptionEvent = canonicalEvents.find(
        (item) => (item as { event_type?: string }).event_type === "frontend_exception"
      ) as Record<string, unknown> | undefined;
      expect(exceptionEvent).toBeDefined();
      const context = exceptionEvent?.context as Record<string, unknown>;
      expect(context.evidence_reference).toEqual({
        version: 1,
        failure_ref: failureRef,
        scope: { kind: "operation", operation_id: operationId }
      });
      expect(context.payout).toEqual({
        tag: "[REDACTED]",
        reference: "[REDACTED]",
        reason: "[REDACTED]",
        file: "[REDACTED]",
        payout_code: "[REDACTED]",
        payout_code_label: "visible-label"
      });
      const payload = exceptionEvent?.payload as Record<string, unknown>;
      expect((payload.exception_evidence as Record<string, unknown>)?.runtime).toBe("react_native");

      const recoveryEvent = canonicalEvents.find(
        (item) => (item as { event_type?: string }).event_type === "diagnostic_context"
      ) as Record<string, unknown> | undefined;
      expect(recoveryEvent?.payload).toMatchObject({
        kind: "recovery",
        failure_ref: failureRef,
        attempt_id: attemptId,
        state: "recovery_observed"
      });
    } finally {
      setNativeModuleForTesting(undefined);
    }
  });

  it("validates and protects protocol evidence fields fail-closed across exception, recovery, and suppression events", () => {
    const failureRef = "11111111-1111-4111-8111-111111111111";
    const pageId = "22222222-2222-4222-8222-222222222222";
    const attemptId = "33333333-3333-4333-8333-333333333333";
    const base: DebugBundleEventEnvelope = {
      schema_version: "1.0",
      event_id: "44444444-4444-4444-8444-444444444444",
      event_type: "frontend_exception",
      timestamp: "2026-01-01T00:00:00.000Z",
      service: { name: "rn-app", environment: "production" },
      sdk_name: "@debugbundle/sdk-react-native",
      sdk_version: "3.1.4",
      payload: {}
    };

    const exceptionEvent = protectEventFields(
      {
        ...base,
        correlation: { session_id: "sess_1" },
        context: {
          evidence_reference: {
            version: 1,
            failure_ref: failureRef,
            scope: { kind: "page", page_id: pageId }
          },
          evidence_limits: {
            exception_evidence: "budget_exceeded",
            recovery: "unsupported"
          },
          tag: "secret-tag"
        },
        payload: {
          exception_evidence: {
            version: 1,
            runtime: "react_native",
            root_id: 0,
            truncated: false,
            unavailable_reason: null,
            nodes: [
              {
                id: 0,
                name: "Error",
                message: "token=abc123",
                stack: "Error: token=abc123\n  at run (app.js:1:2)",
                trace_origin: "throw",
                parsing_status: "parsed",
                frames: [
                  { function: "run", file: "app.js", line: 1, column: 2, classification: "app" },
                  { function: null, file: null, line: null, column: null, classification: "unknown" }
                ],
                relationships: [{ kind: "cause", target_id: 1 }]
              },
              {
                id: 1,
                name: "CauseError",
                message: "root cause",
                stack: null,
                trace_origin: "capture",
                parsing_status: "unavailable",
                frames: [],
                relationships: []
              }
            ]
          }
        }
      },
      ["tag", "reason", "file", "reference"],
      ["payout"]
    );
    expect(exceptionEvent).not.toBeNull();
    expect(exceptionEvent?.context).toMatchObject({
      evidence_reference: { version: 1, failure_ref: failureRef, scope: { kind: "page", page_id: pageId } },
      evidence_limits: { exception_evidence: "budget_exceeded", recovery: "unsupported" },
      tag: "[REDACTED]"
    });
    expect((exceptionEvent?.payload.exception_evidence as { nodes: Array<{ message: string; frames: unknown[]; relationships: unknown[] }> }).nodes[0]).toMatchObject({
      message: "token=[REDACTED]",
      relationships: [{ kind: "cause", target_id: 1 }]
    });

    const suppressed = protectEventFields(
      {
        ...base,
        event_type: "error_suppressed",
        payload: { reason: "queue_pressure", dropped: 3 }
      },
      ["reason"]
    );
    expect(suppressed?.payload).toEqual({ reason: "queue_pressure", dropped: 3 });

    const recovery = protectEventFields(
      {
        ...base,
        event_type: "diagnostic_context",
        payload: {
          version: 1,
          kind: "recovery",
          failure_ref: failureRef,
          scope: { kind: "page", page_id: pageId },
          attempt_id: attemptId,
          state: "attempt_completed",
          operation: "checkout tag=secret",
          status_code: 200,
          duration_ms: 42
        }
      },
      ["reason"],
      ["tag"]
    );
    expect(recovery?.payload).toEqual({
      version: 1,
      kind: "recovery",
      failure_ref: failureRef,
      scope: { kind: "page", page_id: pageId },
      attempt_id: attemptId,
      state: "attempt_completed",
      operation: "checkout tag=[REDACTED]",
      status_code: 200,
      duration_ms: 42
    });

    expect(
      protectEventFields({ ...base, correlation: { session_id: "password=secret" } }, [])
    ).toBeNull();
    expect(
      protectEventFields({ ...base, event_type: "diagnostic_context", payload: { version: 1, kind: "recovery" } }, [])
    ).toBeNull();
    expect(
      protectEventFields(
        {
          ...base,
          event_type: "diagnostic_context",
          payload: {
            version: 1,
            kind: "recovery",
            failure_ref: failureRef,
            scope: { kind: "page", page_id: pageId },
            attempt_id: attemptId,
            state: "attempt_failed",
            status_code: 999
          }
        },
        []
      )
    ).toBeNull();
    expect(
      protectEventFields(
        {
          ...base,
          event_type: "diagnostic_context",
          payload: {
            version: 1,
            kind: "recovery",
            failure_ref: failureRef,
            scope: { kind: "page", page_id: pageId },
            attempt_id: attemptId,
            state: "attempt_failed",
            duration_ms: -1
          }
        },
        []
      )
    ).toBeNull();
    expect(
      protectEventFields({ ...base, context: [] as unknown as Record<string, unknown> }, [])
    ).toBeNull();
    const invalidEvidence = protectEventFields(
      {
        ...base,
        context: {
          evidence_reference: { version: 2, failure_ref: "bad", scope: { kind: "other" } },
          evidence_limits: { unknown_key: "unsupported" }
        },
        payload: {
          exception_evidence: { version: 1, runtime: "invalid", root_id: 0, truncated: false, unavailable_reason: null, nodes: [] }
        }
      },
      ["reference", "reason"]
    );
    expect(invalidEvidence?.context).toEqual({
      evidence_reference: "[REDACTED]",
      evidence_limits: { unknown_key: "unsupported" }
    });
  });
});
