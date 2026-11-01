// In-process write-to-visible lag for the flag ruleset.
// A successful setRollout invalidates the one cache tag; the next read observes the new revision.
// Skipping invalidate leaves a fresh hit on the previous revision for FLAGS_MAX_AGE_S.
//
//   node --experimental-strip-types scripts/flags-propagation.ts [--rounds 20]
//
// No network, no deploy, no token.
import { measureRounds } from '../src/flags/propagation.ts';
import { FLAGS_MAX_AGE_S, FLAGS_SWR_S } from '../src/flags/ttl.ts';

const arg = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] ?? null : null;
};
const rounds = Number(arg('rounds') ?? 20);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) {
  console.error('flags-propagation: --rounds is an integer from 1 to 1000');
  process.exit(2);
}

const measured = await measureRounds(rounds);
console.log(JSON.stringify({
  rounds,
  maxAgeS: FLAGS_MAX_AGE_S,
  swrS: FLAGS_SWR_S,
  p50Ms: measured.p50,
  p95Ms: measured.p95,
  p99Ms: measured.p99,
  staleWithoutInvalidate: measured.staleWithoutInvalidate,
  samples: measured.rounds.map(round => round.lagMs),
}, null, 2));
