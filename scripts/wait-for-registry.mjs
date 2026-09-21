import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ATTEMPTS = 20;
const DEFAULT_INTERVAL_MS = 30_000;
const RETRYABLE_STATUSES = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

export async function waitForRegistryVisibility({
  packageName,
  version,
  fetchImpl = fetch,
  sleep = delay,
  attempts = DEFAULT_ATTEMPTS,
  intervalMs = DEFAULT_INTERVAL_MS,
  log = console.log,
}) {
  if (!packageName || !version || !Number.isInteger(attempts) || attempts < 1) {
    throw new Error("A package name, version, and positive attempt count are required.");
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const url = new URL(
      `${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
      "https://registry.npmjs.org/"
    );
    url.searchParams.set("cache_bust", `${Date.now()}-${attempt}`);

    try {
      const response = await fetchImpl(url.toString(), {
        cache: "no-store",
        headers: { accept: "application/json", "cache-control": "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });

      if (response.ok) {
        const metadata = await response.json();
        if (
          metadata.name !== packageName ||
          metadata.version !== version ||
          typeof metadata.dist?.integrity !== "string" ||
          metadata.dist.integrity.length === 0
        ) {
          throw new Error(`Visible registry metadata does not match ${packageName}@${version}.`);
        }
        log(`${packageName}@${version} is visible on the public npm registry.`);
        return metadata;
      }

      if (!RETRYABLE_STATUSES.has(response.status)) {
        throw new Error(`Registry visibility check failed with HTTP ${response.status}.`);
      }
      log(`Package not visible on npm yet (HTTP ${response.status}); retry ${attempt}/${attempts}.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Visible registry metadata")) {
        throw error;
      }
      if (error instanceof Error && error.message.startsWith("Registry visibility check failed")) {
        throw error;
      }
      log(`npm registry request failed; retry ${attempt}/${attempts}: ${String(error)}`);
    }

    if (attempt < attempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(`${packageName}@${version} was not visible after ${attempts} attempts.`);
}

async function main() {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  await waitForRegistryVisibility({ packageName: manifest.name, version: manifest.version });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
