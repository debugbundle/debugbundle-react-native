import { readFileSync } from "node:fs";

const [, , reportPath, ...sourceNames] = process.argv;
if (!reportPath || sourceNames.length === 0) {
  throw new Error("Usage: check-native-coverage.mjs <llvm-export.json> <source>...");
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const files = report.data?.flatMap((entry) => entry.files ?? []) ?? [];
for (const sourceName of sourceNames) {
  const matches = files.filter((entry) => entry.filename?.endsWith(sourceName));
  if (matches.length !== 1) {
    throw new Error(
      `${sourceName}: expected one LLVM coverage entry, found ${matches.length}`
    );
  }
  const lines = matches[0]?.summary?.lines;
  if (!lines || typeof lines.percent !== "number") {
    throw new Error(`${sourceName}: line coverage is missing`);
  }
  if (lines.percent < 80) {
    throw new Error(
      `${sourceName}: line coverage ${lines.percent.toFixed(2)}% is below 80.00%`
    );
  }
  console.log(`${sourceName}: line coverage ${lines.percent.toFixed(2)}%`);
}
