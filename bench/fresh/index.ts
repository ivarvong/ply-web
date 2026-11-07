// ply-fresh: platform probes and freshness measurement for ply's refs cache (docs: lab_notebook ply-web-refs-2026-11-07).
//
// Probe (cache-enabled entrypoint): GET /<tag>/<n> answers {"fill": <ms>, "ver": <version id>} with
//   public, max-age=3600 and Cache-Tag <tag>. purge(tags) runs ctx.cache.purge inside Probe (tags are entrypoint-scoped).
// Default entrypoint (cache off):
//   GET  /v/<tag>/<n>          → Probe through ctx.exports, + x-cache (cf-cache-status), x-colo, x-ver
//   POST /purge  {tags}        → Probe.purge (bearer)
//   POST /do-purge {tags}      → the same purge, called from a Durable Object's ctx.exports (bearer)
//   POST /watch {...}          → Watcher DOs in each region: warm, then poll until the observed value changes (bearer)
//   GET  /now                  → this machine's Date.now() (clock offset estimates)
// Watcher (DO, locationHint): observes a URL (regex group 1 of the body) every pollMs, records every change.
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

type Env = { PLY_TOKEN: string; LOAD_TOKEN: string; W: DurableObjectNamespace<Watcher>; VERSION: { id: string } };
type Obs = { t: number; value: string; status: number; cache: string; colo: string; ver: string; ms: number };

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function authorized(req: Request, env: Env): boolean {
  return env.PLY_TOKEN.length > 0 && req.headers.get('authorization') === `Bearer ${env.PLY_TOKEN}`;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, Math.max(0, ms)));

export class Probe extends WorkerEntrypoint<Env> {
  override async fetch(req: Request): Promise<Response> {
    const tag = new URL(req.url).pathname.split('/')[1] || 'none';
    return new Response(JSON.stringify({ fill: Date.now(), ver: this.env.VERSION.id }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', 'cache-tag': tag },
    });
  }
  async purge(tags: string[]): Promise<{ ms: number; result: unknown }> {
    const t0 = Date.now();
    const cache = (this.ctx as unknown as { cache: { purge(o: { tags: string[] }): Promise<unknown> } }).cache;
    const result = await cache.purge({ tags });
    return { ms: Date.now() - t0, result };
  }
}

async function observe(url: string, headers: Record<string, string>, regex: string): Promise<Obs> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    const m = new RegExp(regex).exec(text);
    return { t: t0, value: m?.[1] ?? `!${res.status}`, status: res.status, cache: res.headers.get('x-cache') || '', colo: res.headers.get('x-colo') || '', ver: res.headers.get('x-ver') || res.headers.get('x-ply-version') || '', ms: Date.now() - t0 };
  } catch (e) {
    return { t: t0, value: '!err', status: -1, cache: '', colo: '', ver: String(e).slice(0, 80), ms: Date.now() - t0 };
  }
}

export class Watcher extends DurableObject<Env> {
  async colo(): Promise<string> {
    const trace = await fetch('https://www.cloudflare.com/cdn-cgi/trace').then(r => r.text()).catch(() => '');
    return /colo=(\w+)/.exec(trace)?.[1] || '?';
  }
  async now(): Promise<number> { return Date.now(); }
  async warm(url: string, headers: Record<string, string>, regex: string, n: number): Promise<Obs[]> {
    const out: Obs[] = [];
    for (let i = 0; i < n; i++) out.push(await observe(url, headers, regex));
    return out;
  }
  /** Poll each URL (round-robin) every pollMs for durMs; keep the first observation and every change, per URL. */
  async watch(targets: { url: string; headers: Record<string, string> }[], regex: string, pollMs: number, durMs: number): Promise<{ colo: string; start: number; changes: Obs[][]; polls: number[] }> {
    const colo = await this.colo();
    const start = Date.now();
    const last: (string | null)[] = targets.map(() => null);
    const changes: Obs[][] = targets.map(() => []);
    const polls = targets.map(() => 0);
    let i = 0;
    while (Date.now() - start < durMs) {
      const k = i % targets.length;
      const tgt = targets[k] as { url: string; headers: Record<string, string> };
      // A rotating rate identity (x-ply-rate-client, honoured only with the load token): 32 clients per watcher, each
      // well under ply's 60 pages/min.
      const headers = 'x-ply-load-token' in tgt.headers ? { ...tgt.headers, 'x-ply-rate-client': `fresh:${colo}:${k}:${i % 32}` } : tgt.headers;
      const o = await observe(tgt.url, headers, regex);
      polls[k] = (polls[k] as number) + 1;
      if (o.value !== last[k]) { (changes[k] as Obs[]).push(o); last[k] = o.value; }
      i++;
      await sleep(pollMs / targets.length - (Date.now() - o.t));
    }
    return { colo, start, changes, polls };
  }
  /** A long watch (up to the alarm's 15 min): started here, run in alarm(), read with result(). */
  async start(cfg: { targets: { url: string; headers: Record<string, string> }[]; regex: string; pollMs: number; durMs: number }): Promise<{ ok: true }> {
    // '$LOAD_TOKEN' in a header value is ply's PLY_LOAD_TOKEN (x-ply-load-token, the load-test rate identity), held here as a
    // secret so it never rides the request.
    const targets = cfg.targets.map(t => ({ url: t.url, headers: Object.fromEntries(Object.entries(t.headers).map(([k, v]) => [k, v === '$LOAD_TOKEN' ? this.env.LOAD_TOKEN : v])) }));
    await this.ctx.storage.put('cfg', { ...cfg, targets });
    await this.ctx.storage.delete('result');
    await this.ctx.storage.setAlarm(Date.now() + 500);
    return { ok: true };
  }
  async alarm(): Promise<void> {
    const cfg = await this.ctx.storage.get<{ targets: { url: string; headers: Record<string, string> }[]; regex: string; pollMs: number; durMs: number }>('cfg');
    if (!cfg) return;
    await this.ctx.storage.put('state', 'running');
    const r = await this.watch(cfg.targets, cfg.regex, cfg.pollMs, cfg.durMs);
    await this.ctx.storage.put('result', r);
    await this.ctx.storage.put('state', 'done');
  }
  async result(): Promise<unknown> {
    return { state: (await this.ctx.storage.get('state')) || 'none', result: (await this.ctx.storage.get('result')) || null };
  }
  async purgeViaExports(tags: string[]): Promise<unknown> {
    const ex = (this.ctx as unknown as { exports?: { Probe?: { purge(t: string[]): Promise<unknown> } } }).exports;
    if (!ex || !ex.Probe) return { error: 'no ctx.exports.Probe in a Durable Object' };
    return ex.Probe.purge(tags);
  }
}

const REGIONS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me'];

function watcher(env: Env, name: string, hint: string) {
  return env.W.get(env.W.idFromName(`${name}:${hint}`), { locationHint: hint as DurableObjectLocationHint });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const ex = (ctx as unknown as { exports: { Probe: Fetcher & { purge(t: string[]): Promise<unknown> } } }).exports;
    if (url.pathname === '/now') return json({ now: Date.now() });
    if (url.pathname.startsWith('/v/')) {
      const res = await ex.Probe.fetch(new Request(`https://probe.internal/${url.pathname.slice(3)}`));
      const body = await res.text();
      const colo = String((req as unknown as { cf?: { colo?: string } }).cf?.colo || '?');
      return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-cache': res.headers.get('cf-cache-status') || 'NONE', 'x-colo': colo, 'x-ver': env.VERSION.id } });
    }
    if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
    if (req.method === 'POST' && url.pathname === '/purge') {
      const { tags } = (await req.json()) as { tags: string[] };
      const t0 = Date.now();
      const r = await ex.Probe.purge(tags);
      return json({ at: t0, done: Date.now(), r });
    }
    if (req.method === 'POST' && url.pathname === '/do-purge') {
      const { tags } = (await req.json()) as { tags: string[] };
      const t0 = Date.now();
      const r = await watcher(env, 'purger', 'enam').purgeViaExports(tags);
      return json({ at: t0, done: Date.now(), r });
    }
    if (req.method === 'POST' && url.pathname === '/clocks') {
      // Clock offsets: each watcher's now() against this machine's, midpoint of the RPC round trip.
      const { name, regions } = (await req.json()) as { name: string; regions?: string[] };
      const out = await Promise.all((regions || REGIONS).map(async h => {
        const w = watcher(env, name, h);
        const best = { off: 0, rtt: Infinity };
        for (let i = 0; i < 5; i++) {
          const a = Date.now(); const n = await w.now(); const b = Date.now();
          if (b - a < best.rtt) { best.rtt = b - a; best.off = n - (a + b) / 2; }
        }
        return { hint: h, ...best };
      }));
      return json(out);
    }
    if (req.method === 'POST' && url.pathname === '/watch-start') {
      const b = (await req.json()) as { name: string; regions: string[]; targets: { url: string; headers: Record<string, string> }[]; regex: string; pollMs: number; durMs: number };
      await Promise.all(b.regions.map(h => watcher(env, b.name, h).start({ targets: b.targets, regex: b.regex, pollMs: b.pollMs, durMs: b.durMs })));
      return json({ ok: true, now: Date.now() });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/watch-result/')) {
      const name = url.pathname.split('/')[2] as string;
      const regions = (url.searchParams.get('regions') || '').split(',');
      return json(await Promise.all(regions.map(async h => ({ hint: h, ...(await watcher(env, name, h).result() as object) }))));
    }
    if (req.method === 'POST' && url.pathname === '/watch') {
      // {name, regions?, targets:[{url, headers}], regex, pollMs, durMs, warm?}: runs the watches, returns them all.
      const b = (await req.json()) as { name: string; regions?: string[]; targets: { url: string; headers: Record<string, string> }[]; regex: string; pollMs: number; durMs: number; warm?: number; purgeAfterMs?: number; purgeTags?: string[]; purgeFromDo?: boolean };
      const regions = b.regions || REGIONS;
      if (b.warm) await Promise.all(regions.map(h => Promise.all(b.targets.map(t => watcher(env, b.name, h).warm(t.url, t.headers, b.regex, b.warm as number)))));
      // Clock offset of each watcher against this machine (best of 5 RPC round trips), so purge times compare.
      const offsets: Record<string, { off: number; rtt: number }> = {};
      await Promise.all(regions.map(async h => {
        const w = watcher(env, b.name, h);
        const best = { off: 0, rtt: Infinity };
        for (let i = 0; i < 5; i++) { const a = Date.now(); const n = await w.now(); const c = Date.now(); if (c - a < best.rtt) { best.rtt = c - a; best.off = n - (a + c) / 2; } }
        offsets[h] = best;
      }));
      const watches = Promise.all(regions.map(async h => ({ hint: h, ...(await watcher(env, b.name, h).watch(b.targets, b.regex, b.pollMs, b.durMs)) })));
      let purge: unknown = null;
      if (b.purgeAfterMs !== undefined && b.purgeTags) {
        await sleep(b.purgeAfterMs);
        const at = Date.now();
        const r = b.purgeFromDo ? await watcher(env, 'purger', 'enam').purgeViaExports(b.purgeTags) : await ex.Probe.purge(b.purgeTags);
        purge = { at, done: Date.now(), r, colo: String((req as unknown as { cf?: { colo?: string } }).cf?.colo || '?') };
      }
      return json({ purge, offsets, watches: await watches });
    }
    return json({ error: 'not found' }, 404);
  },
};
