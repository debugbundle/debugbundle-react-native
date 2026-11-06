// Synchronous native-object ownership only: no time window or text matching.
const reporting = new Set<unknown>();
export function isReportingError(error: unknown): boolean { return reporting.has(error); }
export function withReportingError(error: unknown, callback: () => void): void {
  if (reporting.has(error)) { callback(); return; }
  reporting.add(error);
  try { callback(); } finally { reporting.delete(error); }
}
