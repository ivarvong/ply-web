// MurmurHash3_x86_32 (Austin Appleby, public domain), seed 0. The bucket is this hash mod 10_000.
// A unit's bucket never changes for a fixed (flag, salt, unit), so raising the percent only adds units.
import { BUCKETS } from './ttl.ts';

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

function mix(k: number): number {
  return Math.imul(rotl(Math.imul(k, C1), 15), C2);
}

/** MurmurHash3_x86_32. `seed` defaults to 0. The result is an unsigned 32-bit integer. */
export function murmur3_32(data: Uint8Array, seed = 0): number {
  let h1 = seed >>> 0;
  const blocks = data.length >>> 2;
  for (let i = 0; i < blocks; i++) {
    const offset = i * 4;
    const k = (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
    h1 ^= mix(k);
    h1 = (Math.imul(rotl(h1, 13), 5) + 0xe6546b64) >>> 0;
  }
  const tail = blocks * 4;
  const rest = data.length & 3;
  if (rest > 0) {
    let k = 0;
    if (rest >= 3) k ^= data[tail + 2]! << 16;
    if (rest >= 2) k ^= data[tail + 1]! << 8;
    k ^= data[tail]!;
    h1 ^= mix(k);
  }
  h1 ^= data.length;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

function u32le(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

/**
 * Length-prefixed UTF-8 of (flag, salt, unit). A NUL inside a field cannot alias another field,
 * because each field carries its byte length.
 */
export function hashMaterial(flagKey: string, salt: string, unitId: string): Uint8Array {
  const encoded = [flagKey, salt, unitId].map(part => new TextEncoder().encode(part));
  const size = encoded.reduce((sum, part) => sum + 4 + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of encoded) {
    out.set(u32le(part.length), offset);
    offset += 4;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Bucket in [0, 9999]. Stable for (flagKey, salt, unitId). */
export function bucketOf(flagKey: string, salt: string, unitId: string): number {
  return murmur3_32(hashMaterial(flagKey, salt, unitId), 0) % BUCKETS;
}

/** True when the unit is inside `percent` (0–100). Threshold is percent × 100, so the ramp is monotonic. */
export function inBucket(bucket: number, percent: number): boolean {
  if (!Number.isInteger(percent) || percent <= 0 || !Number.isInteger(bucket) || bucket < 0 || bucket >= BUCKETS) return false;
  if (percent >= 100) return true;
  return bucket < percent * (BUCKETS / 100);
}
