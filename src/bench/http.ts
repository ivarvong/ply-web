// The /bench routes. Every one is private: src/index.js admits a request only with PLY_TOKEN (a Bearer header, or
// HTTP Basic with PLY_TOKEN as the password, so a browser can sign in without any script). A run is started by a
// same-origin form POST (Sec-Fetch-Site / Origin checked) and answers with a redirect to its page once it is over.
import { dig } from '../absent.ts';
import { VIEWER_CSP } from '../viewer/script.ts';
import { CATALOGUE, findScenario } from './catalogue.ts';
import type { Counts, StartAnswer } from './entry.ts';
import { REPLAY_FORMAT, replayJson, replaySlug, replayTest, type Replay } from './export.ts';
import { page, type Html } from './html.ts';
import { BENCH_CSS, indexPage, messagePage, runPage } from './render.ts';
import type { RunSummary, StoredRun } from './store.ts';
import { renderRay } from '../rays.ts';
import { PLY_SHA } from '../version.ts';

export type BenchRpc = {
  start(scenario: string, seed: string): Promise<StartAnswer>;
  runs(limit: number): Promise<RunSummary[]>;
  run(id: string): Promise<StoredRun | null>;
  body(id: string, i: number, which: 'request' | 'response'): Promise<Uint8Array | null>;
  counts(): Promise<Counts>;
};
const BENCH_NAME = 'bench';
const FORM_MAX = 4096;

export type BenchRoute =
  | { readonly tag: 'css' }
  | { readonly tag: 'index' }
  | { readonly tag: 'start' }
  | { readonly tag: 'run'; readonly id: string }
  | { readonly tag: 'body'; readonly id: string; readonly i: number; readonly which: 'request' | 'response' }
  | { readonly tag: 'export'; readonly id: string; readonly file: 'json' | 'test' };

export const isBenchPath = (path: string): boolean => path === '/bench' || path === '/bench.css' || path.startsWith('/bench/');

export function benchRoute(method: string, path: string): BenchRoute | null {
  if (method === 'GET' && path === '/bench.css') return { tag: 'css' };
  if (method === 'GET' && (path === '/bench' || path === '/bench/')) return { tag: 'index' };
  if (method === 'POST' && path === '/bench/runs') return { tag: 'start' };
  if (method !== 'GET') return null;
  const run = /^\/bench\/runs\/([0-9a-f]{16})$/.exec(path);
  if (run !== null) return { tag: 'run', id: String(run[1]) };
  const body = /^\/bench\/runs\/([0-9a-f]{16})\/exchanges\/(\d{1,5})\/(request|response)$/.exec(path);
  if (body !== null) return { tag: 'body', id: String(body[1]), i: Number(body[2]), which: body[3] === 'request' ? 'request' : 'response' };
  const ex = /^\/bench\/runs\/([0-9a-f]{16})\/[a-z0-9-]+\.(json|test\.js)$/.exec(path);
  if (ex !== null) return { tag: 'export', id: String(ex[1]), file: ex[2] === 'json' ? 'json' : 'test' };
  return null;
}
// The route label for spans and logs: never a run id.
export const benchRouteKey = (r: BenchRoute | null): string => (r === null ? 'bench unmatched' : `bench ${r.tag}`);

export function benchStub(ctx: unknown): BenchRpc | null {
  const ns = dig(ctx, ['exports', 'ProbeBench']);
  if (ns.tag === 'none' || !ns.value) return null;
  const space = ns.value as { idFromName(name: string): unknown; get(id: unknown): BenchRpc };
  if (typeof space.idFromName !== 'function') return null;
  return space.get(space.idFromName(BENCH_NAME));
}

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': VIEWER_CSP, 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' };
const htmlOut = (status: number, h: Html): Response => new Response(page(h), { status, headers: HTML_HEADERS });
const fileOut = (body: BodyInit, type: string, name: string): Response => new Response(body, { status: 200, headers: { 'content-type': type, 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${name}"`, 'x-content-type-options': 'nosniff' } });

// A same-origin form post: the browser says so (Sec-Fetch-Site), or the Origin is this host.
export function sameOrigin(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site !== null) return site === 'same-origin';
  const origin = req.headers.get('origin');
  return origin !== null && origin === new URL(req.url).origin;
}

export function replayOf(run: StoredRun): Replay | null {
  const entry = findScenario(run.scenario);
  const r = run.result;
  if (entry.tag === 'none' || r.end === null || r.verdict.tag === 'harness') return null;
  const differences = r.verdict.tag === 'fail' ? r.verdict.failures.map(f => ({ pair: f.difference.pair, field: f.difference.field, left: f.difference.left, right: f.difference.right })) : [];
  return { format: REPLAY_FORMAT, run: run.id, seed: run.seed, ply: run.ply, scenario: entry.value.scenario, observed: { steps: r.steps, end: r.end }, names: r.names, differences, cfRays: r.exchanges.map(x => renderRay(x.cfRay)) };
}

export async function handleBench(req: Request, ctx: unknown, route: BenchRoute | null): Promise<Response> {
  if (route === null) return htmlOut(404, messagePage('Not found', 'No such workbench page.'));
  if (route.tag === 'css') return new Response(BENCH_CSS, { status: 200, headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' } });
  const stub = benchStub(ctx);
  if (stub === null) return htmlOut(503, messagePage('Unavailable', 'The ProbeBench object is not bound to this Worker.'));
  switch (route.tag) {
    case 'index': {
      const [runs, counts] = await Promise.all([stub.runs(25), stub.counts()]);
      return htmlOut(200, indexPage(CATALOGUE, runs, counts, PLY_SHA, null));
    }
    case 'start': {
      if (!sameOrigin(req)) return htmlOut(403, messagePage('Refused', 'A run is started only from the workbench page itself.'));
      const text = (await req.text()).slice(0, FORM_MAX);
      const form = new URLSearchParams(text);
      const answer = await stub.start(String(form.get('scenario')), String(form.get('seed')));
      if (answer.tag === 'refused') return htmlOut(answer.status, messagePage('Not started', answer.reason));
      return new Response(null, { status: 303, headers: { location: `/bench/runs/${answer.run}`, 'cache-control': 'no-store' } });
    }
    case 'run': {
      const run = await stub.run(route.id);
      if (run === null) return htmlOut(404, messagePage('No such run', `There is no run ${route.id}.`));
      const entry = findScenario(run.scenario);
      return htmlOut(200, runPage(run, entry.tag === 'some' ? entry.value.scenario : null));
    }
    case 'body': {
      const bytes = await stub.body(route.id, route.i, route.which);
      if (bytes === null) return htmlOut(404, messagePage('No body', 'That exchange carried no body, or it was not kept.'));
      return fileOut(new Uint8Array(bytes), 'application/octet-stream', `${route.id}-${route.i}.${route.which}.bin`);
    }
    case 'export': {
      const run = await stub.run(route.id);
      const replay = run === null ? null : replayOf(run);
      if (replay === null) return htmlOut(404, messagePage('Nothing to export', 'This run observed nothing to replay (no end state).'));
      const slug = replaySlug(replay);
      return route.file === 'json' ? fileOut(replayJson(replay), 'application/json; charset=utf-8', `${slug}.json`) : fileOut(replayTest(replay), 'text/javascript; charset=utf-8', `${slug}.test.js`);
    }
  }
}
