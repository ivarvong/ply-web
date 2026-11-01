// Ratchet for JavaScript absence spellings. The boundary module (src/absent.ts) is the
// only exempt file. Everywhere else, the four needles below may only decrease.
//
// Needles are built from pieces so this file does not itself contain them. Comments
// and string literals count: the gate is a grep, not a parser. A checked-in baseline
// must match the scan exactly, and on a pull request each count must be <= the base.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BOUNDARY = "src/absent.ts";
export const BASELINE_PATH = "scripts/absence-baseline.json";

const EXEMPT = new Set([BOUNDARY]);
const ROOTS = ["src", "scripts", "test", "cloudflare.config.ts", "vite.config.ts"];
const SKIP_DIRS = new Set(["node_modules", ".cloudflare", "dist", "coverage", ".git"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const NEEDLES = {
  word: `\\b${"un"}${"defined"}\\b`,
  optional: `\\${"?"}:`,
  chain: `\\${"?"}\\${"."}`,
  nullish: `\\${"?"}\\${"?"}`,
} as const;

const KEYS = ["word", "optional", "chain", "nullish", "total"] as const;

const LABEL: Readonly<Record<(typeof KEYS)[number], string>> = {
  word: "absence-word",
  optional: "optional-member",
  chain: "optional-chain",
  nullish: "nullish",
  total: "total",
};

export type AbsenceCounts = {
  readonly word: number;
  readonly optional: number;
  readonly chain: number;
  readonly nullish: number;
  readonly total: number;
};

export type AbsenceBaseline = {
  readonly boundary: typeof BOUNDARY;
  readonly counts: AbsenceCounts;
  readonly files: Readonly<Record<string, AbsenceCounts>>;
};

type Part = {
  word: number;
  optional: number;
  chain: number;
  nullish: number;
};

export function repoRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

export function scanSource(text: string): AbsenceCounts {
  return withTotal(tally(text));
}

export function scanRepo(root: string): AbsenceBaseline {
  const paths: string[] = [];
  for (const entry of ROOTS) collect(root, entry, paths);
  paths.sort();
  const files: Record<string, AbsenceCounts> = {};
  const sum: Part = { word: 0, optional: 0, chain: 0, nullish: 0 };
  for (const path of paths) {
    const rel = normalize(relative(root, path));
    if (EXEMPT.has(rel)) continue;
    const counts = scanSource(readFileSync(path, "utf8"));
    if (counts.total === 0) continue;
    files[rel] = counts;
    sum.word += counts.word;
    sum.optional += counts.optional;
    sum.chain += counts.chain;
    sum.nullish += counts.nullish;
  }
  return { boundary: BOUNDARY, counts: withTotal(sum), files };
}

export function riseReasons(next: AbsenceCounts, previous: AbsenceCounts): readonly string[] {
  const reasons: string[] = [];
  for (const key of KEYS) {
    if (next[key] > previous[key]) reasons.push(`${LABEL[key]} rose from ${previous[key]} to ${next[key]}`);
  }
  return reasons;
}

export function drift(scan: AbsenceBaseline, baseline: AbsenceBaseline): readonly string[] {
  const lines: string[] = [];
  if (baseline.boundary !== BOUNDARY) lines.push("baseline boundary is not the gate boundary");
  for (const key of KEYS) {
    if (scan.counts[key] !== baseline.counts[key]) {
      lines.push(`${LABEL[key]}: scan ${scan.counts[key]}, baseline ${baseline.counts[key]}`);
    }
  }
  const paths = [...new Set([...Object.keys(scan.files), ...Object.keys(baseline.files)])].sort();
  for (const path of paths) {
    const left = scan.files[path];
    const right = baseline.files[path];
    if (!left || !right) {
      lines.push(left ? `${path}: missing from the baseline` : `${path}: baseline lists a clean file`);
      continue;
    }
    for (const key of KEYS) {
      if (left[key] !== right[key]) lines.push(`${path} ${LABEL[key]}: scan ${left[key]}, baseline ${right[key]}`);
    }
  }
  return lines;
}

export function parseBaseline(text: string): AbsenceBaseline {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error("absence baseline is not an object");
  if (raw.boundary !== BOUNDARY) throw new Error("absence baseline boundary does not match the gate");
  const counts = parseCounts(raw.counts, "counts");
  if (!isRecord(raw.files)) throw new Error("absence baseline files is not an object");
  const files: Record<string, AbsenceCounts> = {};
  for (const path of Object.keys(raw.files).sort()) {
    files[path] = parseCounts(raw.files[path], path);
  }
  return { boundary: BOUNDARY, counts, files };
}

export function renderBaseline(baseline: AbsenceBaseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export function formatCounts(counts: AbsenceCounts): string {
  return KEYS.map((key) => `${LABEL[key]} ${counts[key]}`).join(", ");
}

function main(argv: readonly string[]): number {
  assertGateIsClean();
  if (EXEMPT.size !== 1 || !EXEMPT.has(BOUNDARY)) {
    console.error("absence gate: the exempt set must be the one boundary module");
    return 1;
  }
  const root = repoRoot();
  const scan = scanRepo(root);
  const parsed = parseArgs(argv);
  if (parsed.tag === "error") {
    console.error(parsed.message);
    return 2;
  }
  const write = parsed.tag === "write";

  const baselineFile = join(root, BASELINE_PATH);
  if (write) {
    if (existsSync(baselineFile)) {
      const previous = parseBaseline(readFileSync(baselineFile, "utf8"));
      const reasons = riseReasons(scan.counts, previous.counts);
      if (reasons.length > 0) {
        console.error("absence gate: --write refused, the baseline may only decrease");
        for (const reason of reasons) console.error(`  ${reason}`);
        return 1;
      }
    }
    writeFileSync(baselineFile, renderBaseline(scan));
    console.log(`absence gate: wrote ${BASELINE_PATH} (${formatCounts(scan.counts)})`);
    return 0;
  }

  if (!existsSync(baselineFile)) {
    console.error(`absence gate: missing ${BASELINE_PATH}; run with --write to create it`);
    return 1;
  }
  const baseline = parseBaseline(readFileSync(baselineFile, "utf8"));
  const lines = drift(scan, baseline);
  if (lines.length > 0) {
    console.error(`absence gate: scan does not match ${BASELINE_PATH}`);
    for (const line of lines) console.error(`  ${line}`);
    console.error("Update a decrease with --write. A rise has to be removed.");
    return 1;
  }
  console.log(`absence gate: ok (${formatCounts(scan.counts)})`);

  if (parsed.tag !== "against") return 0;
  const ref = parsed.ref;
  const previous = readBaselineAt(ref, root);
  if (previous === null) {
    console.log(`absence gate: ${ref} has no baseline yet; decrease check skipped`);
    return 0;
  }
  const reasons = riseReasons(scan.counts, previous.counts);
  if (reasons.length > 0) {
    console.error(`absence gate: baseline rose relative to ${ref}`);
    for (const reason of reasons) console.error(`  ${reason}`);
    return 1;
  }
  console.log(`absence gate: did not rise relative to ${ref} (${formatCounts(previous.counts)})`);
  return 0;
}

type CliArgs =
  | { readonly tag: "check" }
  | { readonly tag: "write" }
  | { readonly tag: "against"; readonly ref: string }
  | { readonly tag: "error"; readonly message: string };

function parseArgs(argv: readonly string[]): CliArgs {
  if (argv.length === 0) return { tag: "check" };
  const head = argv[0];
  if (argv.length === 1 && head === "--write") return { tag: "write" };
  if (argv.length === 2 && head === "--against") {
    const ref = argv[1];
    if (typeof ref !== "string" || !validRef(ref)) return { tag: "error", message: "absence gate: --against needs a git ref" };
    return { tag: "against", ref };
  }
  return { tag: "error", message: "absence gate: pass no arguments, --write, or --against <ref>" };
}

function readBaselineAt(ref: string, cwd: string): AbsenceBaseline | null {
  try {
    const text = execFileSync("git", ["show", `${ref}:${BASELINE_PATH}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseBaseline(text);
  } catch (error: unknown) {
    if (missingBaseline(error)) return null;
    const message = error instanceof Error ? error.message : "git show failed";
    throw new Error(`absence gate could not read ${ref}:${BASELINE_PATH}: ${message}`);
  }
}

function missingBaseline(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  let stderr = "";
  if ("stderr" in error && typeof error.stderr === "string") stderr = error.stderr;
  const message = error instanceof Error ? error.message : "";
  const text = `${message}\n${stderr}`;
  return text.includes("does not exist") || text.includes("exists on disk, but not in");
}

function validRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith("-") && !ref.includes(":") && !ref.includes("..");
}

function collect(root: string, entry: string, out: string[]): void {
  const abs = join(root, entry);
  if (!existsSync(abs)) return;
  const stat = statSync(abs);
  if (stat.isDirectory()) {
    const parts = entry.split(sep);
    const name = parts[parts.length - 1];
    if (typeof name === "string" && SKIP_DIRS.has(name)) return;
    for (const child of readdirSync(abs)) collect(root, join(entry, child), out);
    return;
  }
  if (stat.isFile() && isCode(entry)) out.push(abs);
}

function isCode(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return EXTENSIONS.has(path.slice(dot));
}

function tally(text: string): Part {
  return {
    word: count(text, NEEDLES.word),
    optional: count(text, NEEDLES.optional),
    chain: count(text, NEEDLES.chain),
    nullish: count(text, NEEDLES.nullish),
  };
}

function count(text: string, source: string): number {
  return [...text.matchAll(new RegExp(source, "g"))].length;
}

function withTotal(part: Part): AbsenceCounts {
  return {
    word: part.word,
    optional: part.optional,
    chain: part.chain,
    nullish: part.nullish,
    total: part.word + part.optional + part.chain + part.nullish,
  };
}

function parseCounts(value: unknown, where: string): AbsenceCounts {
  if (!isRecord(value)) throw new Error(`absence baseline ${where} is not an object`);
  const part: Part = {
    word: integer(value.word, `${where}.word`),
    optional: integer(value.optional, `${where}.optional`),
    chain: integer(value.chain, `${where}.chain`),
    nullish: integer(value.nullish, `${where}.nullish`),
  };
  const total = integer(value.total, `${where}.total`);
  const counts = withTotal(part);
  if (counts.total !== total) throw new Error(`absence baseline ${where}.total does not add up`);
  return counts;
}

function integer(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`absence baseline ${where} is not a non-negative integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(path: string): string {
  return path.split(sep).join("/");
}

function assertGateIsClean(): void {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const counts = scanSource(text);
  if (counts.total === 0) return;
  const lines: number[] = [];
  for (const source of Object.values(NEEDLES)) {
    const re = new RegExp(source, "g");
    for (const match of text.matchAll(re)) {
      const index = typeof match.index === "number" ? match.index : 0;
      lines.push(text.slice(0, index).split("\n").length);
    }
  }
  throw new Error(`absence gate matched its own source at lines ${lines.join(", ")} (${formatCounts(counts)})`);
}

assertGateIsClean();

const invoked = process.argv[1];
if (typeof invoked === "string" && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main(process.argv.slice(2)));
}
