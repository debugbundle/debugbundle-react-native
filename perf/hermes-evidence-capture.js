// Copied into the synthetic installed app only; never included in SDK packages.
import { createDebugBundleClient } from '@debugbundle/sdk-react-native';
import { createRecordingNativeModule, installRecordingNativeModule, resetDebugBundleNativeModule } from '@debugbundle/sdk-react-native/testing';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

let sequence = 0;
function uuid() {
  return `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

function stats() {
  return globalThis.HermesInternal?.getInstrumentedStats?.() ?? {};
}

function delta(after, before, key) {
  return Number.isFinite(after[key]) && Number.isFinite(before[key]) ? after[key] - before[key] : null;
}

// Holds native promises to isolate Hermes facade work. The same app separately
// verifies real TurboModule/ART HTTP delivery; ART costs have their own fixture.
export async function runHermesEvidencePerformance(endpoint) {
  const rows = [];
  try {
    check(globalThis.HermesInternal != null, 'This comparison requires actual Hermes');
    const proof = { version: 1, features: ['exception_evidence_v1', 'recovery_v1'] };
    for (let repeat = 0; repeat < 4; repeat++) {
      for (const evidence of [false, true]) for (const pressure of [false, true]) {
        const native = createRecordingNativeModule({ status: 'healthy', evidenceCapabilities: proof });
        const retained = [], releases = [];
        native.enqueueCanonicalEventJson = wire => {
          retained.push(wire);
          return new Promise(resolve => releases.push(resolve));
        };
        installRecordingNativeModule(native);
        const client = createDebugBundleClient({ projectToken: 'synthetic', environment: 'local',
          captureExceptionEvidence: evidence, captureRecoveryObservations: evidence });
        try {
          if (pressure) for (let index = 0; index < 224; index++) client.captureLog(`retained warning ${index}`, 'warning');
          const pairs = 20;
          const errors = Array.from({ length: pairs }, (_, index) => {
            const error = new Error(`primary ${index}`);
            Object.defineProperty(error, 'cause', { value: new Error(`cause ${index}`) });
            return error;
          });
          const evidenceScope = { kind: 'operation', operation_id: uuid() };
          const contexts = errors.map(() => ({ failureRef: uuid(), evidenceScope }));
          const observations = contexts.map(context => ({ ...context, attemptId: uuid(), state: 'attempt_completed', statusCode: 200 }));
          const before = stats();
          const start = performance.now();
          for (let index = 0; index < pairs; index++) {
            client.captureException(errors[index], contexts[index]);
            client.captureRecovery(observations[index]);
          }
          const elapsed = performance.now() - start;
          const after = stats();
          const events = retained.map(wire => JSON.parse(wire));
          const primary = events.filter(event => event.event_type === 'frontend_exception');
          check(primary.length === pairs, 'Primary events were lost');
          for (const event of primary) {
            check(('exception_evidence' in event.payload) === evidence, 'Graph enablement mismatch');
            if (evidence) check(event.payload.exception_evidence.nodes.length === 2, 'Native Hermes cause was lost');
          }
          check(events.filter(event => event.event_type === 'diagnostic_context').length === (evidence && !pressure ? pairs : 0), 'Diagnostic pressure mismatch');
          check(client.pendingNativeCalls <= 256 && client.pendingNativeBytes <= 4 * 1024 * 1024, 'Native staging exceeded its bound');
          check(client.evidence.budget.accountedBytes <= 65536, 'Diagnostic budget exceeded its bound');
          if (repeat > 0) rows.push({ repeat, runtime: 'hermes', evidence, pressure, pairs,
            capture_ns_per_pair: elapsed * 1e6 / pairs,
            runtime_allocated_bytes: delta(after, before, 'js_totalAllocatedBytes'),
            runtime_live_bytes_delta: delta(after, before, 'js_allocatedBytes'),
            retained_count: client.pendingNativeCalls, retained_wire_bytes: client.pendingNativeBytes,
            diagnostic_bytes: client.evidence.budget.accountedBytes });
        } finally {
          releases.forEach(resolve => resolve(true));
          await client.flush();
          for (let turn = 0; turn < 5 && client.pendingNativeCalls; turn++) await Promise.resolve();
          check(client.pendingNativeCalls === 0 && client.pendingNativeBytes === 0, 'Native staging was not released');
          resetDebugBundleNativeModule();
        }
      }
    }
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'hermes', properties: globalThis.HermesInternal.getRuntimeProperties?.(), rows }) });
    check(response.ok, 'Hermes performance receipt was rejected');
  } catch (error) {
    await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: String(error) }) });
    throw error;
  }
}
