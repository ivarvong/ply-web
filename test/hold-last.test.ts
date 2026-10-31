// GET /v1/read's body (src/hold-last.ts): the final bytes are released only once the verified source has ended, so a
// complete Content-Length body is never on the wire while verification is still running, and a failed verification
// leaves the body short.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdLastChunk } from '../src/hold-last.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(b));

// ply's openBlob shape: each chunk is passed on as soon as it is hashed; the hash is checked in flush, after the last
// chunk. `verify` is that check; it resolves (verified) or rejects (corrupt) when the test says so.
function verifyingSource(chunks: string[], verify: Promise<void>) {
  return new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(enc(x)); c.close(); } })
    .pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctl) { ctl.enqueue(chunk); }, async flush() { await verify; } }));
}

function gate() { let open!: () => void, fail!: (e: Error) => void; const p = new Promise<void>((a, b) => { open = a; fail = b; }); return { p, open, fail }; }

test('without the hold, the whole body is readable before verification ends (the canceled-read race)', async () => {
  const g = gate();
  const r = verifyingSource(['hello ', 'world'], g.p).getReader();
  const got: Uint8Array[] = [];
  for (let i = 0; i < 2; i++) { const x = await r.read(); assert.equal(x.done, false); got.push(x.value!); }
  assert.equal(dec(got), 'hello world', 'every byte is out while the check is pending');
  g.open(); assert.equal((await r.read()).done, true);
});

test('holdLastChunk: the last chunk waits for the source to end, then the body ends with it', async () => {
  const g = gate();
  const r = holdLastChunk(verifyingSource(['hello ', 'wor', 'ld'], g.p)).getReader();
  const got: Uint8Array[] = [];
  got.push((await r.read()).value!); got.push((await r.read()).value!);
  assert.equal(dec(got), 'hello wor');
  let settled = false;
  const last = r.read().then(x => { settled = true; return x; });
  for (let i = 0; i < 20; i++) await new Promise(res => setImmediate(res));
  assert.equal(settled, false, 'the final chunk is held while verification is pending');
  g.open();
  const x = await last; assert.equal(x.done, false); got.push(x.value!);
  assert.equal(dec(got), 'hello world');
  assert.equal((await r.read()).done, true);
});

test('holdLastChunk: a failed verification errors the stream with the last chunk never released (short body)', async () => {
  const g = gate();
  const r = holdLastChunk(verifyingSource(['abc', 'def'], g.p)).getReader();
  assert.equal(dec([(await r.read()).value!]), 'abc');
  const pending = r.read();
  g.fail(Object.assign(new Error('blob content hashes to x'), { code: 'pack_corrupt' }));
  await assert.rejects(pending, (e: { code?: string }) => e.code === 'pack_corrupt');
});

test('holdLastChunk: a single-chunk blob (the common small file) is released only at the end; empty chunks and empty blobs pass', async () => {
  const g = gate();
  const r = holdLastChunk(verifyingSource(['tiny'], g.p)).getReader();
  let settled = false;
  const first = r.read().then(x => { settled = true; return x; });
  for (let i = 0; i < 20; i++) await new Promise(res => setImmediate(res));
  assert.equal(settled, false);
  g.open();
  assert.equal(dec([(await first).value!]), 'tiny');
  assert.equal((await r.read()).done, true);
  const e = holdLastChunk(verifyingSource(['', 'a', '', 'b', ''], Promise.resolve())).getReader();
  const out: Uint8Array[] = []; for (;;) { const x = await e.read(); if (x.done) break; out.push(x.value); }
  assert.deepEqual(out.map(b => new TextDecoder().decode(b)), ['a', 'b']);
  assert.equal((await holdLastChunk(verifyingSource([], Promise.resolve())).getReader().read()).done, true);
});
