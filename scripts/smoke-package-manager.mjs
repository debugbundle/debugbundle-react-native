import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { installNodeReactNativeStub } from "./node-react-native-stub.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const packageManager = process.argv[2] ?? "npm";
const supportedManagers = new Set(["npm", "pnpm", "yarn"]);
if (!supportedManagers.has(packageManager)) {
  throw new Error(`Unsupported package manager ${packageManager}`);
}

const smokeRoot = await mkdtemp(join(tmpdir(), `debugbundle-rn-${packageManager}-`));
let tarball = "";

async function run(command, args, cwd) {
  await execFileAsync(command, args, {
    cwd,
    env: { ...process.env, CI: "true" },
    maxBuffer: 10 * 1024 * 1024
  });
}

try {
  const { stdout } = await execFileAsync("npm", ["pack", "--json"], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024
  });
  const [{ filename }] = JSON.parse(stdout);
  tarball = join(repoRoot, filename);
  const reactNativeStub = await installNodeReactNativeStub(smokeRoot);

  await writeFile(
    join(smokeRoot, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@debugbundle/sdk-react-native": `file:${tarball}`,
        "react-native": reactNativeStub
      }
    }, null, 2)
  );

  if (packageManager === "npm") {
    await run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps"], smokeRoot);
  } else if (packageManager === "pnpm") {
    await run("pnpm", ["install", "--ignore-scripts", "--strict-peer-dependencies=false"], smokeRoot);
  } else {
    await run("yarn", ["install", "--ignore-scripts", "--ignore-engines"], smokeRoot);
  }

  await writeFile(
    join(smokeRoot, "smoke.mjs"),
    `
      import { createDebugBundleClient } from "@debugbundle/sdk-react-native";
      import { installRecordingNativeModule, createRecordingNativeModule } from "@debugbundle/sdk-react-native/testing";

      const nativeModule = installRecordingNativeModule();
      const client = createDebugBundleClient({
        projectToken: "dbp_package_manager_smoke",
        service: "package-manager-smoke",
        environment: "test"
      });
      client.captureException(new Error("package manager smoke"));
      if (nativeModule.events.length !== 1 || nativeModule.events[0].sdk_name !== "@debugbundle/sdk-react-native") {
        throw new Error("installed package did not preserve the React Native event boundary");
      }
      const evidenceNative = installRecordingNativeModule(createRecordingNativeModule({ status: "healthy",
        evidenceCapabilities: { version: 1, features: ["exception_evidence_v1", "recovery_v1"] } }));
      const evidenceClient = createDebugBundleClient({ projectToken: "dbp_package_manager_smoke", captureRecoveryObservations: true });
      const failureRef = "11111111-1111-4111-8111-111111111111";
      evidenceClient.withOperationContext(() => {
        evidenceClient.captureException(new Error("package evidence", { cause: new Error("native cause") }), { failureRef });
        evidenceClient.captureRecovery({ failureRef, attemptId: "22222222-2222-4222-8222-222222222222", state: "attempt_completed", statusCode: 200 });
      });
      await evidenceClient.flush();
      const failure = evidenceNative.events.find(event => event.event_type === "frontend_exception");
      const recovery = evidenceNative.events.find(event => event.event_type === "diagnostic_context");
      if (failure?.payload.exception_evidence?.nodes.length !== 2 || recovery?.payload.failure_ref !== failureRef
          || recovery?.payload.state !== "attempt_completed" || recovery?.payload.status_code !== 200
          || JSON.stringify(recovery?.payload.scope) !== JSON.stringify(failure?.context.evidence_reference.scope)) {
        throw new Error("installed package did not preserve independent recovery and cause evidence");
      }
    `
  );
  await run("node", ["smoke.mjs"], smokeRoot);
  console.log(`${packageManager} clean-install smoke passed`);
} finally {
  if (tarball) {
    await rm(tarball, { force: true });
  }
  await rm(smokeRoot, { recursive: true, force: true });
}
