// Which part of a viewer URL failed, and the sentence the error page leads with.
import { captureGroup } from '../absent.ts'
import { unwrapOr } from '../option.ts'
import { repoIdentity } from './identity.ts'

export type FailurePart = 'repo' | 'ref' | 'path' | 'request';

export type FailureView = {
  /** HTTP status the page and the response use. GitHub's 401 for a missing repo is shown as 404. */
  status: number;
  part: FailurePart;
  summary: string;
};

const NOT_FOUND = 404;
const UNAUTHORIZED = 401;

export function repoLabel(host: string, repoPath: string): string {
  const id = repoIdentity(host, repoPath);
  return id.scope ? `${id.scope}/${id.name}` : id.name;
}

function captured(match: RegExpExecArray | null): string {
  return unwrapOr(captureGroup(match, 1), '');
}

function refNamed(message: string, ref: string | null): string {
  const missing = captured(/^ref (.+) not found/.exec(message));
  if (missing !== '') return missing;
  const abbrev = captured(/^abbreviated oid ([0-9a-f]+)/.exec(message));
  if (abbrev !== '') return abbrev;
  if (ref && ref.length > 0) return ref;
  return 'HEAD';
}

function pathNamed(message: string, path: string): string {
  if (path) return path;
  const component = captured(/path component (\S+) not found/.exec(message));
  if (component !== '') return component;
  const directory = captured(/^(\S+) is not a directory/.exec(message));
  if (directory !== '') return directory;
  return 'that path';
}

function failurePart(code: string, message: string, ref: string | null, path: string, missingOrPrivate: boolean): FailurePart {
  if (missingOrPrivate) return 'repo';
  if (/^ref .+ not found/.test(message) || /^abbreviated oid /.test(message) || /remote HEAD is unborn/.test(message)) return 'ref';
  if (/path component \S+ not found/.test(message) || / is not a directory/.test(message) || / is not a directory \(mode /.test(message)) return 'path';
  if (/no repository |not a repository|not a git|advertisement/.test(message)) return 'repo';
  if (code === 'not_found' && path) return 'path';
  if (code === 'not_found' && ref) return 'ref';
  if (code === 'not_found') return 'repo';
  return 'request';
}

/** "no repository x …" → "No repository x …", like every other headline. */
function sentenceCase(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1);
}

function inRepo(label: string): string {
  return label ? ` in ${label}` : '';
}

/**
 * GitHub answers 401 for a missing repository and a private one. The page says which, keeps that
 * explanation, and uses 404 so a client does not treat "no such public repo" as an auth challenge.
 */
export function describeFailure(input: {
  code: string;
  status: number;
  message: string;
  host: string;
  repoPath: string;
  ref: string | null;
  path: string;
}): FailureView {
  const missingOrPrivate = input.code === 'auth' && input.status === UNAUTHORIZED;
  const status = missingOrPrivate ? NOT_FOUND : input.status;
  const part = failurePart(input.code, input.message, input.ref, input.path, missingOrPrivate);
  const label = input.host && input.repoPath ? repoLabel(input.host, input.repoPath) : '';
  let summary = input.message;
  if (part === 'repo' && missingOrPrivate) summary = label ? `Repository ${label} not found, or private` : 'Repository not found, or private';
  else if (part === 'repo' && /no repository (\S+)/.exec(input.message)) summary = sentenceCase(input.message);
  else if (part === 'ref') summary = `No ref ${refNamed(input.message, input.ref)}${inRepo(label)}`;
  else if (part === 'path') summary = `No path ${pathNamed(input.message, input.path)}${inRepo(label)}`;
  else if (part === 'repo' && label) summary = `Repository ${label} not found`;
  return { status, part, summary };
}
