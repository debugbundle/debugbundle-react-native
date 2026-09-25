import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve only the freshly installed tarball and its package-shaped React Native peer.
assert.equal(typeof globalThis.gc, "function", "Run this installed-artifact check with --expose-gc");
assert.ok(process.argv[2], "Expected the installed consumer directory");
const installed = createRequire(resolve(process.argv[2], "package.json"));
const { createDebugBundleClient } = await import(pathToFileURL(installed.resolve("@debugbundle/sdk-react-native")));
const { installRecordingNativeModule } = await import(pathToFileURL(installed.resolve("@debugbundle/sdk-react-native/testing")));
const nextTurn = () => new Promise(setImmediate);

for (const canonical of [true, false]) {
  const nativeModule = installRecordingNativeModule();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let sent = 0;
  const enqueue = event => {
    assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 64 * 1024, "Bridge received an oversized projection");
    sent += 1;
    return held;
  };
  if (canonical) nativeModule.enqueueCanonicalEvent = enqueue;
  else {
    delete nativeModule.enqueueCanonicalEvent;
    nativeModule.enqueueEvent = enqueue;
  }
  const returned = [];
  const client = createDebugBundleClient({
    projectToken: "dbp_installed_ownership",
    beforeSend(event) {
      // Schema-valid application output projects to a small safe marker. Holding
      // this raw object in an async bridge frame defeats all serialized accounting.
      const replacement = {
        ...event,
        payload: { ...event.payload, attributes: { large: "x".repeat(1_000_000) } }
      };
      returned.push(new WeakRef(replacement));
      return replacement;
    }
  });
  for (let index = 0; index < 10; index += 1) client.captureLog(`event-${index}`, "error");
  await nextTurn();
  for (let turn = 0; turn < 5; turn += 1) {
    globalThis.gc();
    await nextTurn();
  }
  assert.equal(sent, 10, "Expected ordinary safe projections to reach the held bridge");
  assert.equal(returned.filter(reference => reference.deref() !== undefined).length, 0,
    "SDK async frames retained uncharged application hook output");
  assert.equal(client.pendingNativeCalls, 10, "Held bridge work must remain charged");
  assert.ok(client.pendingNativeBytes > 0 && client.pendingNativeBytes <= 4 * 1024 * 1024);
  release(true);
  await nextTurn();
  assert.equal(client.pendingNativeCalls, 0, "Settled bridge calls must release ownership");
  assert.equal(client.pendingNativeBytes, 0, "Settled bridge bytes must release ownership");
}
console.log("installed canonical/legacy hook GC ownership passed");
