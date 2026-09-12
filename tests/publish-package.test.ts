import { describe, expect, it } from "vitest";
// @ts-expect-error The release helper executes directly in Node without compilation.
import { verifyExistingPackage } from "../scripts/publish-package.mjs";

const packed = { name: "@debugbundle/sdk-react-native", version: "1.3.0", integrity: "sha512-verified" };
const published = { ...packed, license: "Apache-2.0", dist: { integrity: packed.integrity } };

describe("immutable npm release retries", () => {
  it("accepts an identical published artifact", () => {
    expect(() => verifyExistingPackage(packed, published)).not.toThrow();
  });
  it.each([
    { name: "different-package" },
    { version: "1.2.0" },
    { license: "MIT" },
    { dist: { integrity: "sha512-other" } },
    { dist: {} },
  ])("rejects inconsistent registry metadata %j", (change) => {
    expect(() => verifyExistingPackage(packed, { ...published, ...change })).toThrow("differs");
  });
});
