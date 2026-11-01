import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { drift, riseReasons, scanRepo, scanSource, type AbsenceCounts } from "../scripts/absence-gate.ts";

const word = ["un", "defined"].join("");

function counts(part: Pick<AbsenceCounts, "word" | "optional" | "chain" | "nullish">): AbsenceCounts {
  return { ...part, total: part.word + part.optional + part.chain + part.nullish };
}

test("the scanner counts each absence spelling, including comments", () => {
  const optional = `a${"?"}: string`;
  const chain = `a${"?"}.b`;
  const nullish = `a${"?"}${"?"} b`;
  const text = `// ${word}\ntype T = { ${optional} }\nconst x = ${chain}\nconst y = ${nullish}\n`;
  assert.deepEqual(scanSource(text), counts({ word: 1, optional: 1, chain: 1, nullish: 1 }));
  assert.equal(scanSource(`not${word}`).word, 0);
  assert.equal(scanSource(`${"?"}a`).optional, 0);
  assert.equal(scanSource(["a", "?", "?", " b ", "?", "?", " c"].join("")).nullish, 2);
});

test("only the boundary module is exempt, and skipped directories are not scanned", () => {
  const root = mkdtempSync(join(tmpdir(), "absence-"));
  try {
    mkdirSync(join(root, "src", "node_modules"), { recursive: true });
    writeFileSync(join(root, "src", "absent.ts"), `export const hole = ${word}\n`);
    writeFileSync(join(root, "src", "use.ts"), `export const hole = ${word}\n`);
    writeFileSync(join(root, "src", "node_modules", "leak.ts"), `export const hole = ${word}\n`);
    const scan = scanRepo(root);
    assert.equal(scan.counts.word, 1);
    assert.equal(scan.counts.total, 1);
    assert.equal(Object.hasOwn(scan.files, "src/absent.ts"), false);
    const use = scan.files["src/use.ts"];
    assert.ok(use);
    assert.equal(use.word, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the baseline may stay or fall, and a rise is refused", () => {
  const previous = counts({ word: 2, optional: 1, chain: 0, nullish: 0 });
  const lower = counts({ word: 1, optional: 1, chain: 0, nullish: 0 });
  const higher = counts({ word: 3, optional: 1, chain: 0, nullish: 0 });
  assert.deepEqual(riseReasons(lower, previous), []);
  assert.deepEqual(riseReasons(previous, previous), []);
  assert.equal(riseReasons(higher, previous).length, 2);
});

test("drift names a file the baseline does not list", () => {
  const clean = counts({ word: 0, optional: 0, chain: 0, nullish: 0 });
  const one = counts({ word: 1, optional: 0, chain: 0, nullish: 0 });
  const lines = drift(
    { boundary: "src/absent.ts", counts: one, files: { "src/use.ts": one } },
    { boundary: "src/absent.ts", counts: clean, files: {} },
  );
  assert.ok(lines.some((line) => line.includes("src/use.ts")));
  assert.ok(lines.some((line) => line.includes("absence-word")));
});

test("the checked-in tree matches its baseline", () => {
  const result = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/absence-gate.ts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.match(result, /absence gate: ok/);
});
