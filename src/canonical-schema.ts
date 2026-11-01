import { eventSchemaData } from "./event-schema-data.js";
import { EventValidationUnavailable, jsonObject, type OwnedJSON } from "./owned-json.js";

const KEYWORDS = new Set(["$schema", "$id", "$comment", "$ref", "type", "anyOf", "const", "enum", "properties",
  "required", "additionalProperties", "items", "minimum", "maximum", "exclusiveMinimum", "minLength", "maxLength",
  "minItems", "maxItems", "format", "pattern"]);
const TYPES = new Set(["null", "boolean", "number", "integer", "string", "array", "object"]);
const choices = (value: OwnedJSON | undefined): OwnedJSON[] => value === undefined ? [] : Array.isArray(value) ? value : [value];

export function canonicalTimestamp(text: string): boolean {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(text)) return false;
  const year = Number(text.slice(0, 4)), month = Number(text.slice(5, 7)), day = Number(text.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]! &&
    Number(text.slice(11, 13)) < 24 && Number(text.slice(14, 16)) < 60 && Number(text.slice(17, 19)) < 60;
}

/** Small closed Draft-7 interpreter for the generated accepting contract. */
export class CanonicalSchema {
  private refs = new Map<string, OwnedJSON>();
  private patterns = new Map<string, RegExp>();
  private root: OwnedJSON;
  constructor(schema: unknown) { this.root = schema as OwnedJSON; this.compile(this.root); }

  private resolve(ref: string): OwnedJSON {
    const cached = this.refs.get(ref);
    if (cached !== undefined) return cached;
    if (!ref.startsWith("#/")) throw new EventValidationUnavailable();
    let value: OwnedJSON | undefined = this.root;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      value = Array.isArray(value) ? value[Number(key)] : jsonObject(value)?.[key];
      if (value === undefined) throw new EventValidationUnavailable();
    }
    this.refs.set(ref, value);
    return value;
  }

  private compile(schema: OwnedJSON): void {
    if (typeof schema === "boolean") return;
    const node = jsonObject(schema);
    if (!node || Object.keys(node).some(key => !KEYWORDS.has(key)) ||
      choices(node.type).some(value => typeof value !== "string" || !TYPES.has(value)) ||
      node.format !== undefined && !["uuid", "date-time"].includes(String(node.format))) throw new EventValidationUnavailable();
    if (typeof node.pattern === "string") this.patterns.set(node.pattern, new RegExp(node.pattern));
    if (typeof node.$ref === "string" && !this.refs.has(node.$ref)) this.compile(this.resolve(node.$ref));
    for (const child of Object.values(jsonObject(node.properties) ?? {})) this.compile(child);
    for (const child of choices(node.anyOf)) this.compile(child);
    for (const key of ["items", "additionalProperties"]) if (node[key] !== undefined) this.compile(node[key]);
  }

  accepts(value: OwnedJSON): boolean {
    let steps = 100_000;
    const check = (schema: OwnedJSON, value: OwnedJSON, depth: number): boolean => {
      if (--steps < 0 || depth > 64) throw new EventValidationUnavailable();
      if (typeof schema === "boolean") return schema;
      const node = jsonObject(schema);
      if (!node) throw new EventValidationUnavailable();
      if (typeof node.$ref === "string") return check(this.resolve(node.$ref), value, depth + 1);
      if (Array.isArray(node.anyOf) && !node.anyOf.some(child => check(child, value, depth + 1))) return false;
      if (node.type !== undefined && !choices(node.type).some(type => this.matches(value, type))) return false;
      if (node.const !== undefined && node.const !== value) return false;
      if (Array.isArray(node.enum) && !node.enum.includes(value)) return false;
      const object = jsonObject(value);
      if (object) {
        if (choices(node.required).some(key => typeof key !== "string" || !Object.hasOwn(object, key))) return false;
        const fields = jsonObject(node.properties) ?? {};
        for (const [key, child] of Object.entries(object)) {
          if (!check((Object.hasOwn(fields, key) ? fields[key] : undefined) ?? node.additionalProperties ?? true, child, depth + 1)) return false;
        }
      }
      if (Array.isArray(value)) {
        if (typeof node.minItems === "number" && value.length < node.minItems ||
          typeof node.maxItems === "number" && value.length > node.maxItems) return false;
        if (node.items !== undefined && !value.every(child => check(node.items!, child, depth + 1))) return false;
      }
      if (typeof value === "string") {
        if (typeof node.minLength === "number" && value.length < node.minLength ||
          typeof node.maxLength === "number" && value.length > node.maxLength) return false;
        if (typeof node.pattern === "string" && !this.patterns.get(node.pattern)!.test(value)) return false;
        if (node.format === "uuid" && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) return false;
        if (node.format === "date-time" && !canonicalTimestamp(value)) return false;
      }
      if (typeof value === "number") {
        if (typeof node.minimum === "number" && value < node.minimum || typeof node.maximum === "number" && value > node.maximum ||
          typeof node.exclusiveMinimum === "number" && value <= node.exclusiveMinimum) return false;
      }
      return true;
    };
    return check(this.root, value, 0);
  }
  private matches(value: OwnedJSON, type: OwnedJSON): boolean {
    if (type === "integer") return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return jsonObject(value) !== null;
    return typeof value === type;
  }
}

let schema: CanonicalSchema | null = null;
try { schema = new CanonicalSchema(eventSchemaData); } catch { /* Unknown generated keywords fail closed. */ }
export function canonicalShape(value: OwnedJSON): boolean {
  if (!schema) throw new EventValidationUnavailable();
  return schema.accepts(value);
}
