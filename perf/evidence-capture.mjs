import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Session } from "node:inspector/promises";
import { createDebugBundleClient } from "../dist/client.js";
import { createRecordingNativeModule, installRecordingNativeModule, resetDebugBundleNativeModule } from "../dist/testing.js";

const pairs = 20;
const proof = { version: 1, features: ["exception_evidence_v1", "recovery_v1"] };
assert.equal(typeof global.gc, "function", "run with --expose-gc");
for (let repeat = 0; repeat < 4; repeat++) {
  for (const sampled of [false, true]) for (const evidence of [false, true]) for (const pressure of [false, true]) {
    const native = createRecordingNativeModule({ status: "healthy", evidenceCapabilities: proof });
    const retained = [], releases = [];
    native.enqueueCanonicalEventJson = wire => {
      retained.push(wire);
      return new Promise(resolve => releases.push(resolve));
    };
    installRecordingNativeModule(native);
    const client = createDebugBundleClient({ projectToken: "synthetic", environment: "local",
      captureExceptionEvidence: evidence, captureRecoveryObservations: evidence });
    let profiler;
    try {
      if (pressure) for (let index = 0; index < 224; index++) client.captureLog(`retained warning ${index}`, "warning");
      const errors = Array.from({ length: pairs }, (_, index) => new Error(`primary ${index}`, { cause: new Error(`cause ${index}`) }));
      const evidenceScope = { kind: "operation", operation_id: randomUUID() };
      const contexts = errors.map(() => ({ failureRef: randomUUID(), evidenceScope }));
      const observations = contexts.map(context => ({ ...context, attemptId: randomUUID(), state: "attempt_completed", statusCode: 200 }));
      global.gc();
      const heapBefore = process.memoryUsage().heapUsed;
      if (sampled) {
        profiler = new Session(); profiler.connect();
        await profiler.post("HeapProfiler.startSampling", { samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
      }
      const started = process.hrtime.bigint();
      for (let index = 0; index < pairs; index++) {
        client.captureException(errors[index], contexts[index]);
        client.captureRecovery(observations[index]);
      }
      const elapsed = Number(process.hrtime.bigint() - started);
      const heapAfter = process.memoryUsage().heapUsed;
      let allocationEstimate = null;
      if (profiler) {
        const { profile } = await profiler.post("HeapProfiler.stopSampling");
        allocationEstimate = profile.samples.reduce((bytes, sample) => bytes + sample.size, 0);
        if (repeat === 3 && evidence && !pressure) {
          const sites = new Map();
          const visit = node => {
            const name = `${node.callFrame.url}:${node.callFrame.functionName}`;
            sites.set(name, (sites.get(name) ?? 0) + node.selfSize);
            node.children.forEach(visit);
          };
          visit(profile.head);
          console.log(JSON.stringify({ allocation_sites: [...sites].sort((left, right) => right[1] - left[1]).slice(0, 8) }));
        }
        profiler.disconnect(); profiler = undefined;
      }
      const events = retained.map(wire => JSON.parse(wire));
      const primary = events.filter(event => event.event_type === "frontend_exception");
      assert.equal(primary.length, pairs);
      for (const event of primary) {
        assert.equal("exception_evidence" in event.payload, evidence);
        if (evidence) assert.equal(event.payload.exception_evidence.nodes.length, 2);
      }
      assert.equal(events.filter(event => event.event_type === "diagnostic_context").length, evidence && !pressure ? pairs : 0);
      assert(client.pendingNativeCalls <= 256);
      assert(client.pendingNativeBytes <= 4 * 1024 * 1024);
      assert(client.evidence.budget.accountedBytes <= 65536);
      if (repeat > 0) console.log(JSON.stringify({ repeat, runtime: process.version, sampled, evidence, pressure, pairs,
        capture_ns_per_pair: elapsed / pairs, estimated_allocated_bytes: allocationEstimate,
        heap_used_delta: heapAfter - heapBefore, retained_count: client.pendingNativeCalls,
        retained_wire_bytes: client.pendingNativeBytes, diagnostic_bytes: client.evidence.budget.accountedBytes }));
    } finally {
      profiler?.disconnect(); releases.forEach(resolve => resolve(true));
      await client.flush();
      for (let turn = 0; turn < 5 && client.pendingNativeCalls; turn++) await Promise.resolve();
      assert.equal(client.pendingNativeCalls, 0); assert.equal(client.pendingNativeBytes, 0);
      resetDebugBundleNativeModule();
    }
  }
}
