// Micro-benchmark of the loopback's per-exchange key work (classify + base64 + keyHash) on a v2 fetch body, against
// the previous implementation inlined here. Run: node --experimental-strip-types --import ./test/register-tsx.mjs bench/gitcache-key.bench.ts
import { classify, keyHash } from '../src/gitcache.ts';

const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s;
const oid = (i: number) => i.toString(16).padStart(40, 'a');
const body = new TextEncoder().encode(`${pkt('command=fetch\n')}${pkt('agent=ply/1\n')}0001${pkt('thin-pack\n')}${pkt('ofs-delta\n')}${pkt('filter tree:0\n')}${pkt(`want ${oid(1)}\n`)}${pkt('deepen 10\n')}${pkt('done\n')}0000`);
const url = 'https://github.com/ivarvong/ply/git-upload-pack';

// Previous implementation (65a7c76).
const oldLatin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] as number); return s; };
function oldClassify(method: string, u: string, b: Uint8Array | null) {
  if (method.toUpperCase() === 'GET') return u.endsWith('/info/refs?service=git-upload-pack') && !b ? 'discover' : null;
  if (!b) return null;
  const t = oldLatin1(b);
  const has = (re: RegExp) => re.test(t);
  if (has(/[0-9a-f]{4}command=ls-refs\n/)) return 'refs';
  if (!has(/[0-9a-f]{4}command=fetch\n/)) return null;
  if (has(/[0-9a-f]{4}have [0-9a-f]{40}\n/) || has(/[0-9a-f]{4}want-ref /) || has(/[0-9a-f]{4}deepen-(since|not) /) || has(/[0-9a-f]{4}shallow [0-9a-f]{40}\n/)) return null;
  return has(/[0-9a-f]{4}want [0-9a-f]{40}\n/) ? 'pack' : null;
}
async function oldKeyHash(kind: string, u: string, p: string, b: Uint8Array | null) {
  const head = new TextEncoder().encode(`ply-gitcache\n${kind}\n${u}\n${p}\n`);
  const all = new Uint8Array(head.length + (b === null ? 0 : b.length));
  all.set(head);
  if (b) all.set(b, head.length);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  let hex = '';
  for (const x of d) hex += x.toString(16).padStart(2, '0');
  return hex;
}
const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 1024) s += String.fromCharCode.apply(null, b.subarray(i, i + 1024) as unknown as number[]); return s; };

async function oldPath() { const k = oldClassify('POST', url, body)!; const h = await oldKeyHash(k, url, 'version=2', body); return h.length + btoa(oldLatin1(body)).length; }
async function newPath() { const t = latin1(body); const k = classify('POST', url, body)!; void t; const h = await keyHash(k, url, 'version=2', body); return h.length + btoa(t).length; }

if ((await oldKeyHash('pack', url, 'version=2', body)) !== (await keyHash('pack', url, 'version=2', body))) throw new Error('key changed');

async function run(name: string, fn: () => Promise<number>, n: number) {
  for (let i = 0; i < 2000; i++) await fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await fn();
  const us = ((performance.now() - t0) * 1000) / n;
  console.log(`${name}: ${us.toFixed(2)} us/exchange`);
}
for (let r = 0; r < 3; r++) { await run('old', oldPath, 20000); await run('new', newPath, 20000); }
