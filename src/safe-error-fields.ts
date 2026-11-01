/** Read primitive native error fields without calling application accessors. */
const nativePrototypes = new Set([Error.prototype, TypeError.prototype, RangeError.prototype, ReferenceError.prototype,
  SyntaxError.prototype, URIError.prototype, EvalError.prototype, ...(typeof AggregateError === "function" ? [AggregateError.prototype] : [])]);
const brandDescriptor = Object.getOwnPropertyDescriptor(Error, "isError");
export const nativeBrand = brandDescriptor && "value" in brandDescriptor && typeof brandDescriptor.value === "function"
  ? brandDescriptor.value as (value: unknown) => boolean : undefined;
let nativeStackGetter: (() => unknown) | undefined;

export function errorField(value: object, key: string): unknown {
  const own = Object.getOwnPropertyDescriptor(value, key);
  if (own) return "value" in own ? own.value : undefined;
  let prototype = Object.getPrototypeOf(value);
  for (let depth = 0; prototype && depth < 4; depth++) {
    if (!nativePrototypes.has(prototype)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}
export function safeErrorStack(value: object): unknown {
  let prototype = Object.getPrototypeOf(value);
  for (let depth = 0; prototype && depth < 4; depth++) {
    if (!nativePrototypes.has(prototype) && prototype !== Object.prototype) return undefined;
    for (const key of ["name", "message"]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (descriptor && (!("value" in descriptor) || typeof descriptor.value !== "string" || descriptor.value.length > 8192)) return undefined;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  for (const key of ["name", "message"]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && (!("value" in descriptor) || typeof descriptor.value !== "string" || descriptor.value.length > 8192)) return undefined;
  }
  const formatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  const limit = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
  if (formatter && (!("value" in formatter) || formatter.value !== undefined) ||
    limit && (!("value" in limit) || typeof limit.value !== "number" || limit.value < 0 || limit.value > 64)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "stack");
  if (descriptor && "value" in descriptor) return descriptor.value;
  if (descriptor?.get && nativeBrand?.(value)) {
    nativeStackGetter ??= Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
    if (descriptor.get === nativeStackGetter) return descriptor.get.call(value);
  }
  return undefined;
}
