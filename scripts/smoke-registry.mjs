import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { installNodeReactNativeStub } from "./node-react-native-stub.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageSpec = `${packageJson.name}@${packageJson.version}`;
const smokeRoot = await mkdtemp(join(tmpdir(), "debugbundle-rn-registry-smoke-"));

try {
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
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", "--legacy-peer-deps", "--registry=https://registry.npmjs.org", packageSpec],
    {
      cwd: smokeRoot,
      stdio: "pipe"
    }
  );
  await writeFile(
    join(smokeRoot, "smoke.mjs"),
    `
      import { createDebugBundleClient } from "@debugbundle/sdk-react-native";
      import { installRecordingNativeModule } from "@debugbundle/sdk-react-native/testing";
      import { createInstrumentedFetch } from "@debugbundle/sdk-react-native/network";

      const nativeModule = installRecordingNativeModule();
      const client = createDebugBundleClient({
        projectToken: "dbp_smoke",
        service: "rn-registry-smoke",
        environment: "test",
        tracePropagationTargets: ["https://api.example.com"]
      });

      client.captureException(new Error("registry smoke"), { password: "secret" });
      if (nativeModule.events.length !== 1) {
        throw new Error("expected explicit exception event");
      }
      if (nativeModule.events[0].sdk_version !== "${packageJson.version}") {
        throw new Error("expected published SDK version ${packageJson.version}");
      }
      if (nativeModule.events[0].context.password !== "[Redacted]") {
        throw new Error("expected redacted context before native enqueue");
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
    `
  );
  await execFileAsync("node", ["smoke.mjs"], { cwd: smokeRoot, stdio: "pipe" });
  console.log(`registry smoke passed for ${packageSpec}`);
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
