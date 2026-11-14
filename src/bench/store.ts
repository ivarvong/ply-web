// The workbench's source of truth: ProbeBench's SQLite (runs, the repositories it created, and the admission window).
// A run's record (steps, end state, every exchange's metadata, the verdict, cleanup counts, its spans) is one JSON row;
// exchange bodies are R2 objects named runs/<run id>/<exchange>.<request|response>.
import type { RunId, RunSeed, RepoName } from './brand.ts';
import type { RunResult } from './run.ts';

export type SqlValue = string | number | null;
export type Sql = { exec(query: string, ...bindings: SqlValue[]): { toArray(): Array<Record<string, unknown>> } };

export type SpanRow = { readonly id: string; readonly parent: string | null; readonly name: string; readonly startMs: number; readonly durationMs: number; readonly ok: boolean; readonly attrs: Readonly<Record<string, string | number | boolean>> };
export type StoredRun = {
  readonly id: RunId;
  readonly scenario: string;
  readonly seed: RunSeed;
  readonly repo: RepoName;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly ply: string;
  readonly result: RunResult;
  readonly spans: readonly SpanRow[];
};
export type RunSummary = { readonly id: RunId; readonly scenario: string; readonly seed: RunSeed; readonly startedAt: number; readonly finishedAt: number; readonly verdict: string; readonly failures: number; readonly exchanges: number; readonly cleaned: boolean };

export const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, scenario TEXT NOT NULL, seed TEXT NOT NULL, repo TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER NOT NULL, verdict TEXT NOT NULL, failures INTEGER NOT NULL, exchanges INTEGER NOT NULL, cleaned INTEGER NOT NULL, record TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at DESC)',
  // every repository the workbench created, until its cleanup is proven (tokens refused, repository gone)
  'CREATE TABLE IF NOT EXISTS repos (name TEXT PRIMARY KEY, run TEXT NOT NULL, created_at INTEGER NOT NULL, cleaned_at INTEGER)',
  // admissions: one row per run started, for the hourly cap
  'CREATE TABLE IF NOT EXISTS admissions (run TEXT PRIMARY KEY, at INTEGER NOT NULL)',
];

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
const str = (v: unknown): string => (typeof v === 'string' ? v : String(v));

export function migrate(sql: Sql): void {
  for (const q of SCHEMA) sql.exec(q);
}
export function admittedSince(sql: Sql, since: number): number {
  const [row] = sql.exec('SELECT COUNT(*) AS n FROM admissions WHERE at >= ?', since).toArray();
  return typeof row === 'object' ? num(row['n']) : 0;
}
export function admit(sql: Sql, run: RunId, at: number): void {
  sql.exec('INSERT INTO admissions (run, at) VALUES (?, ?)', run, at);
  sql.exec('DELETE FROM admissions WHERE at < ?', at - 7 * 24 * 3600 * 1000);
}
export function repoCreated(sql: Sql, name: RepoName, run: RunId, at: number): void {
  sql.exec('INSERT OR REPLACE INTO repos (name, run, created_at, cleaned_at) VALUES (?, ?, ?, NULL)', name, run, at);
}
export function repoCleaned(sql: Sql, name: RepoName, at: number): void {
  sql.exec('UPDATE repos SET cleaned_at = ? WHERE name = ?', at, name);
}
export function uncleaned(sql: Sql, before: number): string[] {
  return sql.exec('SELECT name FROM repos WHERE cleaned_at IS NULL AND created_at < ? ORDER BY created_at', before).toArray().map(r => str(r['name']));
}
export function cleanupCounts(sql: Sql): { readonly created: number; readonly cleaned: number } {
  const [row] = sql.exec('SELECT COUNT(*) AS created, COUNT(cleaned_at) AS cleaned FROM repos').toArray();
  return typeof row === 'object' ? { created: num(row['created']), cleaned: num(row['cleaned']) } : { created: 0, cleaned: 0 };
}

export function saveRun(sql: Sql, r: StoredRun): void {
  const failures = r.result.verdict.tag === 'fail' ? r.result.verdict.failures.length : 0;
  const c = r.result.cleanup;
  sql.exec(
    'INSERT OR REPLACE INTO runs (id, scenario, seed, repo, started_at, finished_at, verdict, failures, exchanges, cleaned, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    r.id, r.scenario, r.seed, r.repo, r.startedAt, r.finishedAt, r.result.verdict.tag, failures, r.result.exchanges.length, c.refused && c.deleted && c.gone ? 1 : 0, JSON.stringify(r),
  );
}
export function loadRun(sql: Sql, id: RunId): StoredRun | null {
  const [row] = sql.exec('SELECT record FROM runs WHERE id = ?', id).toArray();
  return typeof row === 'object' ? (JSON.parse(str(row['record'])) as StoredRun) : null;
}
export function listRuns(sql: Sql, limit: number): RunSummary[] {
  return sql.exec('SELECT id, scenario, seed, started_at, finished_at, verdict, failures, exchanges, cleaned FROM runs ORDER BY started_at DESC LIMIT ?', limit).toArray().map(r => ({
    id: str(r['id']) as RunId, scenario: str(r['scenario']), seed: str(r['seed']) as RunSeed, startedAt: num(r['started_at']), finishedAt: num(r['finished_at']),
    verdict: str(r['verdict']), failures: num(r['failures']), exchanges: num(r['exchanges']), cleaned: num(r['cleaned']) === 1,
  }));
}
