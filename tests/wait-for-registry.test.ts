import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The release helper executes directly in Node without compilation.
import { waitForRegistryVisibility } from "../scripts/wait-for-registry.mjs";

const packageName = "@debugbundle/sdk-react-native";
const version = "2.0.0";

function response(status: number, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

describe("npm registry visibility wait", () => {
  it("waits through propagation misses and accepts matching public metadata", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(
        response(200, { name: packageName, version, dist: { integrity: "sha512-published" } })
      );
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForRegistryVisibility({ packageName, version, fetchImpl, sleep, attempts: 5, intervalMs: 1 })
    ).resolves.toMatchObject({ name: packageName, version });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain(encodeURIComponent(packageName));
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  });

  it("fails closed when visible metadata does not match the requested package", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response(200, { name: packageName, version: "1.9.0", dist: { integrity: "sha512-other" } })
    );

    await expect(
      waitForRegistryVisibility({ packageName, version, fetchImpl, sleep: vi.fn(), attempts: 1 })
    ).rejects.toThrow("metadata does not match");
  });

  it("fails after the bounded propagation window without an extra sleep", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(404));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForRegistryVisibility({ packageName, version, fetchImpl, sleep, attempts: 3, intervalMs: 1 })
    ).rejects.toThrow("not visible after 3 attempts");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
