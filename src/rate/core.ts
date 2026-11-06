// RateCounter's logic over a minimal SQL interface (docs/rate-limit.md "Durable Object side"). The Durable Object
// (src/rate/counter.ts) hands it ctx.storage.sql; the tests hand it node:sqlite. Every method is synchronous: under the
// Durable Object's input gate, the dedupe check and the writes of one apply() are one atomic transaction.
import {
  BUCKET_PACK,
  BUCKET_PAGE,
  DEDUPE_RETENTION_MS,
  KEY_HEX,
  MAX_BATCH_KEYS,
  MAX_DOC_ENTRIES,
  PRUNE_EVERY_MS,
  SLOT_MS,
  WINDOW_MS,
} from './config.ts';

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;
export type SqlCursorLike = { toArray(): SqlRow[]; readonly rowsWritten: number };
export type SqlExec = (query: string, ...bindings: SqlValue[]) => SqlCursorLike;

/** One client's admitted hits in one batch: [key16, bucket, count]. */
export type BatchEntry = readonly [string, number, number];
export type FaultKind = 'slow-ack' | 'error';
export type Fault = { readonly kind: FaultKind; readonly ms: number; readonly attempts: number };
export type ApplyRequest = {
  readonly id: string;
  readonly attempt: number;
  /** [page limit, pack limit] per window. */
  readonly limits: readonly [number, number];
  readonly entries: readonly BatchEntry[];
  readonly fault: Fault | null;
};
export type OverKey = { readonly k: string; readonly b: number; readonly sum: number; readonly limit: number; readonly crossed: number; readonly peak: number };
export type ApplyResult = {
  readonly replay: boolean;
  readonly keys: number;
  readonly hits: number;
  readonly newBlocks: number;
  readonly rowsWritten: number;
  readonly gen: number;
  readonly over: readonly OverKey[];
};
/** [key16, bucket, until ms, crossed ms]. */
export type DocEntry = readonly [string, number, number, number];
export type BlockedDoc = { readonly v: 1; readonly gen: number; readonly at: number; readonly entries: readonly DocEntry[] };

const KEY_RE = new RegExp(`^[0-9a-f]{${KEY_HEX}}$`);
const ID_RE = /^[0-9A-Za-z:_-]{1,96}$/;
const MAX_COUNT = 1_000_000;
const MAX_LIMIT = 1_000;

export class InvalidBatch extends Error {
  override name = 'InvalidBatch';
}

function validLimit(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_LIMIT;
}

/** Throws InvalidBatch on anything a ply isolate would not send. */
export function checkApply(req: ApplyRequest): void {
  if (typeof req.id !== 'string' || !ID_RE.test(req.id)) throw new InvalidBatch('id');
  if (!Number.isSafeInteger(req.attempt) || req.attempt < 1) throw new InvalidBatch('attempt');
  if (!Array.isArray(req.limits) || req.limits.length !== 2 || !validLimit(req.limits[0]) || !validLimit(req.limits[1])) throw new InvalidBatch('limits');
  if (!Array.isArray(req.entries) || req.entries.length > MAX_BATCH_KEYS) throw new InvalidBatch('entries');
  for (const e of req.entries) {
    if (!Array.isArray(e) || e.length !== 3) throw new InvalidBatch('entry');
    const [k, b, n] = e;
    if (typeof k !== 'string' || !KEY_RE.test(k)) throw new InvalidBatch('key');
    if (b !== BUCKET_PAGE && b !== BUCKET_PACK) throw new InvalidBatch('bucket');
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_COUNT) throw new InvalidBatch('count');
  }
}

/** The first slot that still counts at `now`: a slot counts while its end is within the last WINDOW_MS. */
export function firstLiveSlot(now: number): number {
  return Math.floor((now - WINDOW_MS) / SLOT_MS);
}

/** When the window sum next drops below `limit`, given live slots ascending. `sum` must be ≥ limit. */
export function blockedUntil(slots: readonly { slot: number; n: number }[], sum: number, limit: number): number {
  let remaining = sum;
  for (const s of slots) {
    remaining -= s.n;
    if (remaining < limit) return (s.slot + 1) * SLOT_MS + WINDOW_MS;
  }
  const last = slots[slots.length - 1];
  return last === void 0 ? 0 : (last.slot + 1) * SLOT_MS + WINDOW_MS;
}

function num(row: SqlRow | void, col: string): number {
  if (row === void 0) return 0;
  const v = row[col];
  return typeof v === 'number' ? v : Number(v);
}

export class CounterCore {
  readonly #sql: SqlExec;
  #lastPrune = 0;

  constructor(sql: SqlExec) {
    this.#sql = sql;
    sql(`CREATE TABLE IF NOT EXISTS rate_hits (k TEXT NOT NULL, b INTEGER NOT NULL, slot INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, b, slot))`);
    sql(`CREATE INDEX IF NOT EXISTS rate_hits_slot ON rate_hits (slot)`);
    sql(`CREATE TABLE IF NOT EXISTS rate_batches (id TEXT PRIMARY KEY, at INTEGER NOT NULL, hits INTEGER NOT NULL)`);
    sql(`CREATE INDEX IF NOT EXISTS rate_batches_at ON rate_batches (at)`);
    sql(`CREATE TABLE IF NOT EXISTS rate_blocked (k TEXT NOT NULL, b INTEGER NOT NULL, until INTEGER NOT NULL, crossed INTEGER NOT NULL, peak INTEGER NOT NULL, PRIMARY KEY (k, b))`);
    sql(`CREATE TABLE IF NOT EXISTS rate_meta (name TEXT PRIMARY KEY, v INTEGER NOT NULL)`);
  }

  gen(): number {
    return num(this.#sql(`SELECT v FROM rate_meta WHERE name = 'gen'`).toArray()[0], 'v');
  }

  #bumpGen(): number {
    const next = this.gen() + 1;
    this.#sql(`INSERT INTO rate_meta (name, v) VALUES ('gen', ?) ON CONFLICT (name) DO UPDATE SET v = excluded.v`, next);
    return next;
  }

  /** Applies a batch once. A replayed id is acknowledged and changes nothing. */
  apply(req: ApplyRequest, now: number): ApplyResult {
    checkApply(req);
    let written = 0;
    const run = (q: string, ...b: SqlValue[]): SqlRow[] => {
      const c = this.#sql(q, ...b);
      const rows = c.toArray();
      written += c.rowsWritten;
      return rows;
    };
    let hits = 0;
    for (const e of req.entries) hits += e[2];
    if (run(`SELECT 1 AS x FROM rate_batches WHERE id = ?`, req.id).length > 0) {
      return { replay: true, keys: req.entries.length, hits, newBlocks: 0, rowsWritten: written, gen: this.gen(), over: [] };
    }
    run(`INSERT INTO rate_batches (id, at, hits) VALUES (?, ?, ?)`, req.id, now, hits);
    const slot = Math.floor(now / SLOT_MS);
    const live = firstLiveSlot(now);
    let newBlocks = 0;
    let changed = false;
    const over: OverKey[] = [];
    for (const [k, b, n] of req.entries) {
      run(`INSERT INTO rate_hits (k, b, slot, n) VALUES (?, ?, ?, ?) ON CONFLICT (k, b, slot) DO UPDATE SET n = n + excluded.n`, k, b, slot, n);
      const limit = req.limits[b === BUCKET_PACK ? 1 : 0];
      const slots = run(`SELECT slot, n FROM rate_hits WHERE k = ? AND b = ? AND slot >= ? ORDER BY slot`, k, b, live).map(r => ({ slot: num(r, 'slot'), n: num(r, 'n') }));
      let sum = 0;
      for (const s of slots) sum += s.n;
      if (sum < limit) continue;
      const until = blockedUntil(slots, sum, limit);
      const prior = run(`SELECT until, crossed, peak FROM rate_blocked WHERE k = ? AND b = ?`, k, b)[0];
      const active = prior !== void 0 && num(prior, 'until') > now;
      const crossed = active ? num(prior, 'crossed') : now;
      const peak = active ? Math.max(num(prior, 'peak'), sum) : sum;
      if (!active) newBlocks++;
      if (!active || num(prior, 'until') !== until || num(prior, 'peak') !== peak) {
        run(`INSERT INTO rate_blocked (k, b, until, crossed, peak) VALUES (?, ?, ?, ?, ?) ON CONFLICT (k, b) DO UPDATE SET until = excluded.until, crossed = excluded.crossed, peak = excluded.peak`, k, b, until, crossed, peak);
        if (!active || num(prior, 'until') !== until) changed = true;
      }
      over.push({ k, b, sum, limit, crossed, peak });
    }
    if (now - this.#lastPrune >= PRUNE_EVERY_MS) {
      this.#lastPrune = now;
      run(`DELETE FROM rate_hits WHERE slot < ?`, live);
      run(`DELETE FROM rate_batches WHERE at < ?`, now - DEDUPE_RETENTION_MS);
      if (run(`SELECT 1 AS x FROM rate_blocked WHERE until <= ? LIMIT 1`, now).length > 0) {
        run(`DELETE FROM rate_blocked WHERE until <= ?`, now);
        changed = true;
      }
    }
    const gen = changed ? this.#bumpGen() : this.gen();
    return { replay: false, keys: req.entries.length, hits, newBlocks, rowsWritten: written, gen, over };
  }

  /** The read side's one document: every block still in force, newest `until` first. */
  doc(now: number): BlockedDoc {
    const rows = this.#sql(`SELECT k, b, until, crossed FROM rate_blocked WHERE until > ? ORDER BY until DESC LIMIT ?`, now, MAX_DOC_ENTRIES).toArray();
    return { v: 1, gen: this.gen(), at: now, entries: rows.map(r => [String(r['k']), num(r, 'b'), num(r, 'until'), num(r, 'crossed')] as const) };
  }

  /** Rows per table, for the stats log. */
  sizes(): { hits: number; batches: number; blocked: number } {
    const c = (t: string): number => num(this.#sql(`SELECT COUNT(*) AS c FROM ${t}`).toArray()[0], 'c');
    return { hits: c('rate_hits'), batches: c('rate_batches'), blocked: c('rate_blocked') };
  }
}
