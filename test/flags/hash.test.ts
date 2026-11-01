import { describe, expect, it } from 'vitest';
import { bucketOf, hashMaterial, inBucket, murmur3_32 } from '../../src/flags/hash.ts';
import { BUCKETS } from '../../src/flags/ttl.ts';

const text = new TextEncoder();

// spaolacci/murmur3 and the Go standard vectors for MurmurHash3_x86_32, seed 0.
const GOLDEN: readonly { readonly input: string; readonly hash: number }[] = [
  { input: '', hash: 0x00000000 },
  { input: 'hello', hash: 0x248bfa47 },
  { input: 'hello, world', hash: 0x149bbb7f },
  { input: '19 Jan 2038 at 3:14:07 AM', hash: 0xe31e8a70 },
  { input: 'The quick brown fox jumps over the lazy dog.', hash: 0xd5c48bfc },
];

const BUCKETS_GOLDEN: readonly { readonly unit: string; readonly bucket: number }[] = [
  { unit: 'anonymous', bucket: 2849 },
  { unit: 'user-1', bucket: 1777 },
  { unit: 'user-2', bucket: 8250 },
];

describe('murmur3_32', () => {
  it('matches the published x86_32 vectors', () => {
    for (const vector of GOLDEN) expect(murmur3_32(text.encode(vector.input), 0)).toBe(vector.hash);
  });
});

describe('bucketOf', () => {
  it('locks ply.usage.note / v1 buckets', () => {
    for (const vector of BUCKETS_GOLDEN) expect(bucketOf('ply.usage.note', 'v1', vector.unit)).toBe(vector.bucket);
  });

  it('length-prefixes fields so concatenation cannot alias', () => {
    const left = murmur3_32(hashMaterial('ab', '', 'c'), 0);
    const right = murmur3_32(hashMaterial('a', 'b', 'c'), 0);
    expect(left).not.toBe(right);
  });
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe('bucketing properties', () => {
  it('stays inside 0..9999 and is stable', () => {
    const random = mulberry32(0xC0FFEE);
    for (let i = 0; i < 200; i++) {
      const flag = `flag.${Math.floor(random() * 1000)}`;
      const unit = `u${Math.floor(random() * 1_000_000)}`;
      const bucket = bucketOf(flag, 'v1', unit);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(BUCKETS);
      expect(bucketOf(flag, 'v1', unit)).toBe(bucket);
    }
  });

  it('is monotonic: a unit inside percent p stays inside every q >= p', () => {
    for (let bucket = 0; bucket < BUCKETS; bucket += 17) {
      let seen = false;
      for (let percent = 0; percent <= 100; percent++) {
        const inside = inBucket(bucket, percent);
        if (seen) expect(inside).toBe(true);
        if (inside) seen = true;
      }
    }
    expect(inBucket(0, 0)).toBe(false);
    expect(inBucket(9999, 100)).toBe(true);
    expect(inBucket(9999, 99)).toBe(false);
    expect(inBucket(0, 1)).toBe(true);
  });

  it('puts about half of a fixed sample inside 50%', () => {
    let inside = 0;
    const total = 4000;
    for (let i = 0; i < total; i++) if (inBucket(bucketOf('ply.usage.note', 'v1', `unit-${i}`), 50)) inside++;
    expect(inside / total).toBeGreaterThan(0.45);
    expect(inside / total).toBeLessThan(0.55);
  });
});
