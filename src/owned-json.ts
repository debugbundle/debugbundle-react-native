export type OwnedJSON = null | boolean | number | string | OwnedJSON[] | { [key: string]: OwnedJSON };

/** Exhausted ownership cannot safely fall back to pre-hook application data. */
export class EventValidationUnavailable extends Error {}

export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

/** Bounded plain JSON copy; no toJSON, property getters, foreign iterators or formatters. */
export function ownJSON(input: unknown): OwnedJSON {
  let nodes = 4096, remaining = 8 * 1024 * 1024;
  const seen = new Set<object>();
  const use = (amount: number): void => { remaining -= amount; if (remaining < 0) throw new EventValidationUnavailable(); };
  const visit = (value: unknown, depth: number): OwnedJSON => {
    if (--nodes < 0 || depth > 16) throw new EventValidationUnavailable();
    if (value === null || typeof value === "boolean") { use(5); return value; }
    if (typeof value === "number" && Number.isFinite(value)) { use(24); return value; }
    if (typeof value === "string") { if (value.length > remaining) throw new EventValidationUnavailable(); use(utf8Bytes(value) + 2); return value; }
    if (typeof value !== "object" || value === null || seen.has(value)) throw new TypeError("invalid JSON");
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 256) throw new EventValidationUnavailable();
        use(value.length + 2);
        return Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !("value" in descriptor)) throw new TypeError("invalid JSON");
          return visit(descriptor.value, depth + 1);
        });
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("invalid JSON");
      const keys = Object.keys(value);
      if (keys.length > 256) throw new EventValidationUnavailable();
      const output: Record<string, OwnedJSON> = Object.create(null);
      for (const key of keys) {
        if (key.length > remaining) throw new EventValidationUnavailable();
        use(utf8Bytes(key) + 4);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) throw new TypeError("invalid JSON");
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally { seen.delete(value); }
  };
  return visit(input, 0);
}

export function jsonObject(value: unknown): Record<string, OwnedJSON> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, OwnedJSON> : null;
}
