import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const smokeRoot = await mkdtemp(join(tmpdir(), "debugbundle-rn-smoke-"));

try {
  await execFileAsync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
  const { stdout } = await execFileAsync("npm", ["pack", "--json"], { cwd: root, stdio: "pipe" });
  const [{ filename }] = JSON.parse(stdout);
  const tarball = join(root, filename);

  await writeFile(
    join(smokeRoot, "package.json"),
    JSON.stringify({ type: "module", private: true }, null, 2)
  );
  await execFileAsync("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", tarball], {
    cwd: smokeRoot,
    stdio: "pipe"
  });
  await writeFile(
    join(smokeRoot, "smoke.mjs"),
    `
      import { createDebugBundleClient } from "@debugbundle/sdk-react-native";
      import { installRecordingNativeModule } from "@debugbundle/sdk-react-native/testing";
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
      if (nativeModule.events[0].payload.context.password !== "[Redacted]") {
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

  await rm(tarball, { force: true });
  console.log("packed smoke passed");
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}
