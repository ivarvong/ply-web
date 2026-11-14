// The workbench's identifiers, each made only by its parser.
import { type Result, err, ok } from './result.ts';

declare const runIdBrand: unique symbol;
declare const runSeedBrand: unique symbol;
declare const repoNameBrand: unique symbol;
// A run: 16 lowercase hex characters, minted by the ProbeBench object.
export type RunId = string & { readonly [runIdBrand]: 'RunId' };
// The caller's seed for a run: what the run's repository is named after and what an export replays under. The plan
// itself fixes every object id; the seed only tells two runs of one plan apart.
export type RunSeed = string & { readonly [runSeedBrand]: 'RunSeed' };
// A repository the workbench creates in the probe namespace: `pb-<seed>-<run id>`.
export type RepoName = string & { readonly [repoNameBrand]: 'RepoName' };

const RUN_ID = /^[0-9a-f]{16}$/;
const RUN_SEED = /^[a-z0-9]{1,16}$/;
const REPO_NAME = /^pb-[a-z0-9]{1,16}-[0-9a-f]{16}$/;
const RUN_ID_BYTES = 8;

export const parseRunId = (s: string): Result<RunId, string> => (RUN_ID.test(s) ? ok(s as RunId) : err('a run id is 16 lowercase hex characters'));
export const parseRunSeed = (s: string): Result<RunSeed, string> => (RUN_SEED.test(s) ? ok(s as RunSeed) : err('a seed is 1 to 16 lowercase letters or digits'));
export const parseRepoName = (s: string): Result<RepoName, string> => (REPO_NAME.test(s) ? ok(s as RepoName) : err('not a workbench repository name'));
export const repoNameFor = (seed: RunSeed, run: RunId): RepoName => `pb-${seed}-${run}` as RepoName;
export function mintRunId(): RunId {
  const b = crypto.getRandomValues(new Uint8Array(RUN_ID_BYTES));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('') as RunId;
}
