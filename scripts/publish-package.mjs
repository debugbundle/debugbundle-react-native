import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function verifyExistingPackage(packed, published) {
  if (published.name !== packed.name || published.version !== packed.version ||
      published.license !== "Apache-2.0" || published.dist?.integrity !== packed.integrity) {
    throw new Error("Published version differs from the verified local artifact; refusing to skip publication.");
  }
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), "debugbundle-release-"));
  try {
    const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", directory], { encoding: "utf8" }));
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packed.name)}/${packed.version}`);
    if (response.ok) {
      verifyExistingPackage(packed, await response.json());
      console.log(`${packed.name}@${packed.version} already published with identical integrity; continuing registry verification.`);
    } else if (response.status === 404) {
      execFileSync("npm", ["publish", join(directory, packed.filename), "--access", "public"], { stdio: "inherit" });
    } else {
      throw new Error(`Registry lookup failed (${response.status}); refusing publication.`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
