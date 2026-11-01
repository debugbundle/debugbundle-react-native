import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

export const runtimeCapabilities = { version: 1, features: ["exception_evidence_v1", "resource_observations_v1", "recovery_v1", "evidence_provenance_v1"] };

export function runtimeIngestionFixture(mockPort, runtimeTimeoutMs, requirePerformance = false) {
  const receivedEventTypes = new Set();
  const runtimeRequestDiagnostics = [];
  let failureReference;
  let recoveryReference;
  let performanceComplete = !requirePerformance;
  let performanceError;
async function startMockIngestion() {
  // Staging native artifacts can run before the TypeScript build; load the
  // accepting validator only for the subsequent installed runtime lane.
  const { canonicalEvent } = await import("../dist/evidence-wire.js");
  const { canonicalShape } = await import("../dist/canonical-schema.js");
  const { ownJSON } = await import("../dist/owned-json.js");
  const server = createServer(async (request, response) => {
    runtimeRequestDiagnostics.push(`${request.method ?? "UNKNOWN"}:${request.url ?? "unknown"}`);
    if (requirePerformance && request.method === 'POST' && request.url === '/runtime-performance') {
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 65536) throw new Error('Oversized performance receipt');
          chunks.push(chunk);
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.error) throw new Error(result.error);
        if (result.runtime !== 'hermes' || result.rows?.length !== 12 ||
            result.rows.some(row => row.runtime !== 'hermes' || !Number.isFinite(row.capture_ns_per_pair) || row.capture_ns_per_pair <= 0 ||
              ![1, 2, 3].includes(row.repeat) || typeof row.evidence !== 'boolean' || typeof row.pressure !== 'boolean' || row.pairs !== 20 ||
              !Number.isInteger(row.retained_count) || row.retained_count < 20 || row.retained_count > 256 ||
              !Number.isInteger(row.retained_wire_bytes) || row.retained_wire_bytes < 1 || row.retained_wire_bytes > 4 * 1024 * 1024 ||
              !Number.isInteger(row.diagnostic_bytes) || row.diagnostic_bytes < 0 || row.diagnostic_bytes > 65536) ||
            new Set(result.rows.map(row => `${row.repeat}:${row.evidence}:${row.pressure}`)).size !== 12) {
          throw new Error('Incomplete Hermes performance receipt');
        }
        console.log('Hermes installed performance receipt: ' + JSON.stringify(result));
        performanceComplete = true;
        response.writeHead(204).end();
      } catch (error) {
        performanceError = String(error);
        response.writeHead(422).end();
      }
      return;
    }
    if (request.method === "GET" && request.url === "/runtime-check") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/v1/sdk/config")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        probes_enabled: true,
        remote_probes_enabled: false,
        active_probes: [],
        poll_interval_ms: 0,
        evidence_capabilities: runtimeCapabilities,
        capture_policy: {
          preset: "balanced",
          capture_logs: "warning",
          capture_request_events: "failures_only",
          capture_breadcrumbs: "exception_only",
          capture_probe_events: "buffer_only",
          capture_diagnostic_context: true,
          immediate_client_error_statuses: [],
          immediate_client_error_path_rules: []
        }
      }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/events") {
      response.writeHead(404);
      response.end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(body.events) || body.events.length === 0) {
      runtimeRequestDiagnostics.push("invalid_batch");
      response.writeHead(400);
      response.end();
      return;
    }
    for (const event of body.events) {
      if (
        event?.schema_version !== "2026-03-01" ||
        event?.sdk_name !== "@debugbundle/sdk-react-native" ||
        event?.sdk_version !== "3.1.0" ||
        event?.service?.name !== "rn-runtime-smoke" ||
        event?.service?.environment !== "test" ||
        event?.event_type !== "diagnostic_context" && event?.context?.release_stage !== "smoke" ||
        typeof event?.event_id !== "string" || !canonicalEvent(ownJSON(event))
      ) {
        runtimeRequestDiagnostics.push(`invalid_event_contract:${JSON.stringify({
          type: event?.event_type, schema: event?.schema_version === "2026-03-01",
          sdk: event?.sdk_name === "@debugbundle/sdk-react-native", version: event?.sdk_version === "3.1.0",
          service: event?.service?.name === "rn-runtime-smoke", environment: event?.service?.environment === "test",
          context: event?.context?.release_stage === "smoke", canonical: canonicalEvent(ownJSON(event)),
          shape: canonicalShape(ownJSON(event)),
          types: JSON.stringify(event, (key, value) => value !== null && typeof value === "object" ? value : typeof value)
        })}`);
        response.writeHead(422);
        response.end();
        return;
      }
      if (event.event_type === "frontend_exception") {
        if (event.payload.exception_evidence?.runtime !== "react_native" || !event.payload.device ||
          event.correlation?.session_id !== "0" || event.correlation?.trace_id !== "rn-runtime-trace") {
          runtimeRequestDiagnostics.push("missing_exception_evidence"); response.writeHead(422).end(); return;
        }
        const reference = event.context.evidence_reference;
        failureReference = JSON.stringify([reference.version, reference.failure_ref, reference.scope.kind, reference.scope.operation_id]);
      }
      if (event.event_type === "diagnostic_context") {
        if (event.payload.kind !== "recovery" || event.payload.state !== "attempt_completed" || event.payload.status_code !== 200 ||
          event.correlation?.session_id !== "0" || event.correlation?.trace_id !== "rn-runtime-trace") {
          runtimeRequestDiagnostics.push("invalid_recovery_evidence"); response.writeHead(422).end(); return;
        }
        recoveryReference = JSON.stringify([1, event.payload.failure_ref, event.payload.scope.kind, event.payload.scope.operation_id]);
      }
      receivedEventTypes.add(event.event_type);
    }
    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({
      accepted: body.events.length,
      rejected: 0,
      errors: [],
      evidence_capabilities: runtimeCapabilities
    }));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(mockPort, resolveListen);
  });
  return server;
}

async function waitForRuntimeEvents() {
  const deadline = Date.now() + runtimeTimeoutMs;
  while (Date.now() < deadline) {
    if (performanceError) throw new Error('Hermes performance failed: ' + performanceError);
    if (receivedEventTypes.has("frontend_exception") && receivedEventTypes.has("request_event") && receivedEventTypes.has("diagnostic_context") &&
      failureReference === recoveryReference && performanceComplete) {
      return;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for React Native runtime delivery; received ` +
    `${[...receivedEventTypes].join(", ") || "no events"}; diagnostics: ` +
    `${runtimeRequestDiagnostics.join(" | ") || "no ingestion requests"}`
  );
}

  return { startMockIngestion, waitForRuntimeEvents };
}
