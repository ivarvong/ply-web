// The scenario catalogue as the workbench offers it: ply's probe plans (`ply/probes`, pinned in package.json), each
// with what a Worker can do with it. A plan only stock git can send has no ply run; a seed larger than the workbench
// holds in memory is refused before anything is created; a concurrent step wider than a Worker's simultaneous
// connections still runs, queued, and says so.
import { SCENARIOS, runsFor, type Scenario, type ScenarioId } from 'ply/probes';
import { find } from '../option.ts';
import type { Option } from '../option.ts';
import { seedBytes } from './seed.ts';

// A Worker holds at most 128 MiB; the seed, its pack and the recorded bodies must fit with room to spare.
export const WORKBENCH_SEED_BYTES = 8 * 1024 * 1024;
// Simultaneous open connections a Worker invocation may hold (developers.cloudflare.com/workers/platform/limits).
export const WORKER_CONNECTIONS = 6;

export type Support =
  | { readonly tag: 'runnable'; readonly notes: readonly string[] }
  | { readonly tag: 'git-only'; readonly why: string }
  | { readonly tag: 'too-large'; readonly bytes: number };

export function supportOf(s: Scenario): Support {
  if (!runsFor(s, 'ply')) {
    const step = s.steps.find(st => st.tag === 'push' && st.ply.tag === 'none');
    const why = typeof step === 'object' && step.tag === 'push' && step.ply.tag === 'none' ? step.ply.why : 'ply has no form of this plan';
    return { tag: 'git-only', why };
  }
  const bytes = seedBytes(s.seed);
  if (bytes > WORKBENCH_SEED_BYTES) return { tag: 'too-large', bytes };
  const notes: string[] = [];
  const widest = Math.max(0, ...s.steps.map(st => (st.tag === 'concurrent' ? st.pushes.length : 1)));
  if (widest > WORKER_CONNECTIONS) notes.push(`a concurrent step of ${widest} pushes: a Worker opens ${WORKER_CONNECTIONS} connections at once, so the rest wait for one to close (less contention than ply's suite applies)`);
  if (s.steps.some(st => st.tag === 'push' && st.from.tag === 'shallow')) notes.push('ply keeps no shallow state: it sends the plan objects as a full client');
  return { tag: 'runnable', notes };
}

export type CatalogueEntry = { readonly scenario: Scenario; readonly support: Support };
export const CATALOGUE: readonly CatalogueEntry[] = SCENARIOS.map(scenario => ({ scenario, support: supportOf(scenario) }));

export function findScenario(id: string): Option<CatalogueEntry> {
  return find(CATALOGUE, e => e.scenario.id === id);
}
export type { ScenarioId };
