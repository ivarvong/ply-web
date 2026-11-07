// ply-load: open-loop, fixed-rate request generators inside Cloudflare (one Durable Object per region × shard).
// Control (bearer = PLY_LOAD_TOKEN, the load-test credential; this Worker never holds PLY_TOKEN, the /v1 bearer):
//   POST /run   {runId, target, version, workload, rate, seconds, arms, clients, fault, regions, shards, targets?, versions?, shared?}
//               shared: client labels omit region and shard, so every generator in the run sends as the SAME clients
//               (a burst from one client spread over regions). Default: each (region, shard) has its own clients.
//               versions: request i is pinned to versions[i % n]; the row's arm index is then the version index.
//               targets: request i goes to targets[(i + per-shard offset) % n]; its index is the row's last field.
//   GET  /run/<runId>?regions=a,b&shards=n   → every shard's state and raw rows
// Workloads: "latency" spreads requests over many synthetic clients, each well under the limit; "abuse" gives each
// client a fixed rate (e.g. 2× the limit) and keeps every (t, status) so the laptop computes enforcement lag and overshoot.
// Requests carry x-ply-load-token (PLY_LOAD_TOKEN), x-ply-rate-client, x-ply-rate-mode (the arm) and, pinned,
// Cloudflare-Workers-Version-Overrides. No address is involved: the client label is the rate identity.
import { DurableObject } from 'cloudflare:workers';

type Env = { PLY_LOAD_TOKEN: string; GEN: DurableObjectNamespace<Generator> };
type Arm = 'legacy' | 'batched' | 'memo' | 'default';
type Fault = { header: string; fromS: number; toS: number };
type ShardCfg = {
  runId: string;
  target: string;
  version: string;
  workload: 'latency' | 'abuse';
  rate: number;
  seconds: number;
  arms: Arm[];
  clients: number;
  fault: Fault | null;
  hint: string;
  shard: number;
  maxInFlight: number;
  /** Optional: request i goes to targets[(i + shard offset) % n] instead of `target` (e.g. one old commit per request, cold upstream). */
  targets?: string[];
  /** Optional: request i is pinned to versions[i % n] (the row's arm index is the version index): a per-request interleaved A/B. */
  versions?: string[];
  /** Optional: one set of client labels for the whole run (no region/shard in the label). */
  shared?: boolean;
};
/** [t ms since start, arm index, client index, status, ttfb ms, total ms, version ok 1/0, target index] */
type Row = [number, number, number, number, number, number, number, number];

const CHUNK = 900;
const HINT_ORDER = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'];
const HINTS = new Set(HINT_ORDER);

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

export class Generator extends DurableObject<Env> {
  #rows: Row[] = [];
  #live = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS run (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rows (seq INTEGER PRIMARY KEY, data TEXT NOT NULL)`);
  }

  #get(k: string): string | null {
    const r = this.ctx.storage.sql.exec<{ v: string }>(`SELECT v FROM run WHERE k = ?`, k).toArray()[0];
    return r === undefined ? null : r.v;
  }
  #set(k: string, v: string): void {
    this.ctx.storage.sql.exec(`INSERT INTO run (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, k, v);
  }

  async start(cfg: ShardCfg): Promise<{ ok: true }> {
    if (this.#get('cfg') !== null) return { ok: true };
    this.#set('cfg', JSON.stringify(cfg));
    this.#set('state', 'pending');
    this.#set('next', '0');
    await this.ctx.storage.setAlarm(Date.now() + 2_000);
    return { ok: true };
  }

  override async alarm(): Promise<void> {
    const raw = this.#get('cfg');
    if (raw === null) return;
    const cfg = JSON.parse(raw) as ShardCfg;
    const state = this.#get('state');
    if (state === 'done' || state === 'failed') return;
    if (state === 'running' && !this.#live) {
      // A restart mid-chunk: keep what was stored, continue from the stored cursor.
      this.#set('restarts', String(Number(this.#get('restarts') || '0') + 1));
    }
    if (state === 'pending') {
      this.#set('state', 'running');
      this.#set('t0', String(Date.now()));
      const trace = await fetch('https://www.cloudflare.com/cdn-cgi/trace').then(r => r.text()).catch(() => '');
      this.#set('colo', /colo=(\w+)/.exec(trace)?.[1] || '?');
    }
    this.#live = true;
    const t0 = Number(this.#get('t0'));
    const total = Math.floor(cfg.rate * cfg.seconds);
    let i = Number(this.#get('next'));
    const end = Math.min(total, i + CHUNK);
    const inflight = new Set<Promise<void>>();
    let shed = Number(this.#get('shed') || '0');
    for (; i < end; i++) {
      const at = t0 + (i * 1000) / cfg.rate;
      await sleep(at - Date.now());
      if (inflight.size >= cfg.maxInFlight) { shed++; continue; }
      const p = this.#one(cfg, i, t0).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    await Promise.all([...inflight]);
    this.ctx.storage.sql.exec(`INSERT INTO rows (data) VALUES (?)`, JSON.stringify(this.#rows));
    this.#rows = [];
    this.#set('next', String(i));
    this.#set('shed', String(shed));
    if (i >= total) {
      this.#set('state', 'done');
      this.#set('ended', String(Date.now()));
    } else {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  async #one(cfg: ShardCfg, i: number, t0: number): Promise<void> {
    const versions = cfg.versions && cfg.versions.length ? cfg.versions : null;
    const armIndex = versions ? i % versions.length : i % cfg.arms.length;
    const arm = versions ? cfg.arms[0] : cfg.arms[armIndex];
    const version = versions ? (versions[armIndex] as string) : cfg.version;
    // latency: rotate over many clients; abuse: every client sends at the shard rate / clients.
    const client = Math.floor(i / cfg.arms.length) % cfg.clients;
    const headers: Record<string, string> = {
      'x-ply-load-token': this.env.PLY_LOAD_TOKEN,
      'x-ply-rate-client': cfg.shared ? `${cfg.runId}:shared:${arm}:${client}` : `${cfg.runId}:${cfg.hint}:${cfg.shard}:${arm}:${client}`,
      'user-agent': 'ply-load/1',
    };
    if (arm !== 'default') headers['x-ply-rate-mode'] = arm;
    if (version) headers['cloudflare-workers-version-overrides'] = `ply="${version}"`;
    const sent = Date.now();
    const t = sent - t0;
    if (cfg.fault !== null && (arm === 'batched' || arm === 'memo') && t >= cfg.fault.fromS * 1000 && t < cfg.fault.toS * 1000) headers['x-ply-rate-fault'] = cfg.fault.header;
    let status = 0;
    let ttfb = 0;
    let verOk = 0;
    const list = cfg.targets && cfg.targets.length ? cfg.targets : null;
    // Each (region, shard) starts at a different offset, so with a list no two generators ask for the same URL first.
    const ti = list ? (i + cfg.shard * 7919 + HINT_ORDER.indexOf(cfg.hint) * 104729) % list.length : -1;
    const target = list ? (list[ti] as string) : cfg.target;
    try {
      const res = await fetch(target, { headers, signal: AbortSignal.timeout(20_000) });
      ttfb = Date.now() - sent;
      status = res.status;
      verOk = !version || res.headers.get('x-ply-version') === version ? 1 : 0;
      await res.arrayBuffer();
    } catch {
      status = -1;
    }
    this.#rows.push([t, armIndex, client, status, ttfb, Date.now() - sent, verOk, ti]);
  }

  report(): { state: string; colo: string; cfg: ShardCfg | null; shed: number; restarts: number; t0: number; rows: Row[] } {
    const raw = this.#get('cfg');
    const rows: Row[] = [];
    for (const r of this.ctx.storage.sql.exec<{ data: string }>(`SELECT data FROM rows ORDER BY seq`).toArray()) rows.push(...(JSON.parse(r.data) as Row[]));
    return {
      state: this.#get('state') || 'none',
      colo: this.#get('colo') || '?',
      cfg: raw === null ? null : (JSON.parse(raw) as ShardCfg),
      shed: Number(this.#get('shed') || '0'),
      restarts: Number(this.#get('restarts') || '0'),
      // Epoch ms of the shard's row clock (t = 0): rows from shards in different regions merge on t0 + t.
      t0: Number(this.#get('t0') || '0'),
      rows,
    };
  }
}

const enc = new TextEncoder();

/** Constant time: both sides hashed to equal-length digests, compared with the platform's timingSafeEqual. */
async function authorized(req: Request, env: Env): Promise<boolean> {
  const secret = typeof env.PLY_LOAD_TOKEN === 'string' ? env.PLY_LOAD_TOKEN : '';
  if (secret.length === 0) return false;
  const h = req.headers.get('authorization') || '';
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(h)), crypto.subtle.digest('SHA-256', enc.encode(`Bearer ${secret}`))]);
  return crypto.subtle.timingSafeEqual(x, y);
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function shardStub(env: Env, runId: string, hint: string, shard: number) {
  return env.GEN.get(env.GEN.idFromName(`${runId}:${hint}:${shard}`), { locationHint: hint as DurableObjectLocationHint });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!(await authorized(req, env))) return json({ error: 'unauthorized' }, 401);
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/run') {
      const body = (await req.json()) as Omit<ShardCfg, 'hint' | 'shard'> & { regions: string[]; shards: number };
      const regions = body.regions.filter(h => HINTS.has(h));
      const started: string[] = [];
      for (const hint of regions) {
        for (let shard = 0; shard < body.shards; shard++) {
          const { regions: _r, shards: _s, ...rest } = body;
          await shardStub(env, body.runId, hint, shard).start({ ...rest, hint, shard, maxInFlight: rest.maxInFlight || 64 });
          started.push(`${hint}/${shard}`);
        }
      }
      return json({ ok: true, runId: body.runId, started });
    }
    const m = /^\/run\/([\w.-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && m !== null) {
      const regions = (url.searchParams.get('regions') || '').split(',').filter(h => HINTS.has(h));
      const shards = Number(url.searchParams.get('shards') || '1');
      const rowsWanted = url.searchParams.get('rows') === '1';
      const out = [];
      for (const hint of regions) {
        for (let shard = 0; shard < shards; shard++) {
          const r = await shardStub(env, m[1], hint, shard).report();
          out.push({ hint, shard, state: r.state, colo: r.colo, shed: r.shed, restarts: r.restarts, t0: r.t0, n: r.rows.length, rows: rowsWanted ? r.rows : [] });
        }
      }
      return json({ ok: true, shards: out });
    }
    return json({ error: 'not found' }, 404);
  },
};
