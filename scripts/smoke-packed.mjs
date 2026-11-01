import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installNodeReactNativeStub } from "./node-react-native-stub.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const smokeRoot = await mkdtemp(join(tmpdir(), "debugbundle-rn-smoke-"));

try {
  await execFileAsync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  const { stdout } = await execFileAsync("npm", ["pack", "--json"], { cwd: root, stdio: "pipe" });
  const [{ filename }] = JSON.parse(stdout);
  const tarball = join(root, filename);

  const reactNativeStub = await installNodeReactNativeStub(smokeRoot);
  await writeFile(
    join(smokeRoot, "package.json"),
    JSON.stringify({
      type: "module",
      private: true,
      dependencies: {
        "react-native": reactNativeStub
      }
    }, null, 2)
  );
  await execFileAsync("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", tarball], {
    cwd: smokeRoot,
    stdio: "pipe"
  });
  await writeFile(join(smokeRoot, "compatibility.ts"), `
    import { createDebugBundleClient, type DebugBundleClient } from "@debugbundle/sdk-react-native";
    declare const legacy: Omit<DebugBundleClient, "evidenceCapabilities" | "beginOperation" | "withOperationContext" | "captureRecovery">;
    const compatible: DebugBundleClient = legacy;
    const current = createDebugBundleClient();
    current.beginOperation().close();
    current.captureRecovery({ failureRef: "", attemptId: "", state: "attempt_completed" });
    void compatible;
  `);
  await execFileAsync(join(root, "node_modules", ".bin", "tsc"), ["--noEmit", "--strict", "--skipLibCheck",
    "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "compatibility.ts"], { cwd: smokeRoot });
  await writeFile(
    join(smokeRoot, "smoke.mjs"),
    `
      import { createDebugBundleClient } from "@debugbundle/sdk-react-native";
      import { installRecordingNativeModule, createRecordingNativeModule } from "@debugbundle/sdk-react-native/testing";
      import { createInstrumentedFetch } from "@debugbundle/sdk-react-native/network";

      const nativeModule = installRecordingNativeModule();
      const client = createDebugBundleClient({
        projectToken: "dbp_smoke",
        service: "rn-smoke",
        environment: "test",
        tracePropagationTargets: ["https://api.example.com"]
      });

      client.captureException(new Error("smoke"), { password: "secret" });
      if (nativeModule.events.length !== 1) {
        throw new Error("expected explicit exception event");
      }
      if (nativeModule.events[0].context.password !== "[REDACTED]") {
        throw new Error("expected redacted context before native enqueue");
      }

      let hookCalled = false;
      const hooked = createDebugBundleClient({ projectToken: "dbp_smoke", beforeSend(event) {
        hookCalled = true;
        return { ...event, payload: { ...event.payload, message: "filtered" } };
      } });
      hooked.captureLog("private application text", "error");
      if (hookCalled) throw new Error("beforeSend ran inside capture");
      await hooked.flush();
      if (!hookCalled || nativeModule.events.at(-1)?.payload.message !== "filtered") {
        throw new Error("deferred hook did not preserve replacement semantics");
      }

      const fetchCalls = [];
      const fetch = createInstrumentedFetch(async (_url, init) => {
        fetchCalls.push(new Headers(init?.headers).get("X-DebugBundle-Trace-Id"));
        return new Response("", { status: 503 });
      }, client, { tracePropagationTargets: ["https://api.example.com"] });
      await fetch("https://api.example.com/orders");
      if (!fetchCalls[0]) {
        throw new Error("expected first-party trace header");
      }
      if (!nativeModule.events.some((event) => event.event_type === "request_event")) {
        throw new Error("expected request_event capture for first-party 503");
      }

      const evidenceNative = installRecordingNativeModule(createRecordingNativeModule({ status: "healthy",
        evidenceCapabilities: { version: 1, features: ["exception_evidence_v1", "recovery_v1"] } }));
      const evidenceClient = createDebugBundleClient({ projectToken: "dbp_smoke", captureRecoveryObservations: true });
      const scope = evidenceClient.beginOperation();
      const failureRef = "11111111-1111-4111-8111-111111111111";
      evidenceClient.captureException(new Error("primary", { cause: new Error("cause") }), { failureRef, session_id: "0" });
      evidenceClient.captureRecovery({ failureRef, attemptId: "22222222-2222-4222-8222-222222222222",
        state: "attempt_completed", statusCode: 200, correlation: { session_id: "0" } });
      scope.close(); await evidenceClient.flush();
      const [failure, recovery] = evidenceNative.events;
      if (evidenceNative.events.length !== 2 || failure.payload.exception_evidence?.runtime !== "react_native" ||
          failure.context.evidence_reference.failure_ref !== recovery.payload.failure_ref ||
          recovery.payload.scope.operation_id !== scope.operationId || recovery.payload.state !== "attempt_completed" ||
          recovery.payload.status_code !== 200 || recovery.correlation.session_id !== "0") {
        throw new Error("installed package did not preserve independent scoped evidence");
      }
    `
  );
  await execFileAsync("node", ["smoke.mjs"], { cwd: smokeRoot, stdio: "pipe" });
  const ownership = await execFileAsync("node", [
    "--expose-gc", join(root, "scripts", "check-installed-ownership.mjs"), smokeRoot
  ], { cwd: smokeRoot, stdio: "pipe" });
  process.stdout.write(ownership.stdout);

  await rm(tarball, { force: true });
  console.log("packed smoke passed");
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
