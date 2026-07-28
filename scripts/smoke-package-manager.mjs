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
      import { installRecordingNativeModule } from "@debugbundle/sdk-react-native/testing";

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
