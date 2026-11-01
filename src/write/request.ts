// Pure reading of a write body. Every rejection here is bad_request and happens before any fetch.
import { fail, parseOid, validateRef, ZERO_OID, type Oid } from 'ply';
import { fromNullable, recordGet } from '../absent.ts';
import { BLOB_MODES, MODE_BLOB, OP_CREATE, OP_DELETE, OP_EDIT, OP_RENAME, OP_WRITE } from './constants.ts';
import { stamp, type Stamp, type UnixSeconds } from './identity.ts';

export type BlobMode = typeof BLOB_MODES[number];

export type BaseSpec =
  | { readonly kind: 'omit' }
  | { readonly kind: 'oid'; readonly oid: Oid }
  | { readonly kind: 'ref'; readonly ref: string };

export type ExpectedHead =
  | { readonly kind: 'any' }
  | { readonly kind: 'oid'; readonly oid: Oid };

export type Change =
  | { readonly kind: 'create'; readonly path: string; readonly content: string; readonly mode: BlobMode }
  | { readonly kind: 'write'; readonly path: string; readonly content: string; readonly mode: BlobMode }
  | { readonly kind: 'edit'; readonly path: string; readonly find: string; readonly replace: string }
  | { readonly kind: 'delete'; readonly path: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string };

export type EditRequest = {
  readonly ref: string | null;
  readonly base: BaseSpec;
  readonly changes: readonly Change[];
  readonly author: Stamp;
  readonly committer: Stamp | null;
  readonly message: string;
  readonly head: ExpectedHead;
  readonly hint: Oid | null;
};

type Body = Record<string, unknown>;

function parsedOid(value: unknown): Oid | null {
  const parsed = parseOid(value);
  return parsed.ok ? parsed.value : null;
}

export function asBody(value: unknown): Body {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail('bad_request', 'body must be a JSON object');
  return value as Body;
}

export function fullRef(name: string): string {
  return name.startsWith('refs/') ? name : `refs/heads/${name}`;
}

/** A branch we may push. A 40-hex string is a commit id, never a branch called that. */
export function branchRef(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw fail('bad_request', `${field} is required`);
  if (value === ZERO_OID) throw fail('bad_request', `${field} must not be the zero oid`);
  if (parsedOid(value)) throw fail('bad_request', `${field} must be a branch name, not a commit id`);
  return validateRef(fullRef(value)) as string;
}

/**
 * A merge `from` or a rebase `onto`. A lowercase 40-hex string is that commit (ply fetches it and 404s a non-commit).
 * The zero oid is rejected here, before a transport opens. Anything else is a branch name.
 */
export function refOrCommit(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw fail('bad_request', `${field} is required`);
  if (value === ZERO_OID) throw fail('bad_request', `${field} must not be the zero oid`);
  if (parsedOid(value)) return value;
  return branchRef(value, field);
}

export function tagRef(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw fail('bad_request', 'name is required');
  if (parsedOid(value)) throw fail('bad_request', 'name must be a tag name, not an object id');
  const full = value.startsWith('refs/tags/') ? value : `refs/tags/${value}`;
  return validateRef(full) as string;
}

/** Missing, null, and empty text. A present 0 or false is not blank. */
function blank(value: unknown): boolean {
  const found = fromNullable(value);
  return found.tag === 'none' || found.value === '';
}

function field(body: Body, key: string) {
  return recordGet(body, key);
}

export function parseBase(value: unknown): BaseSpec {
  if (blank(value)) return { kind: 'omit' };
  if (typeof value !== 'string') throw fail('bad_request', 'base must be a branch name or a 40-hex commit id');
  if (value === ZERO_OID) throw fail('bad_request', 'base must not be the zero oid; omit base to create a root commit');
  const baseOid = parsedOid(value);
  if (baseOid) return { kind: 'oid', oid: baseOid };
  return { kind: 'ref', ref: branchRef(value, 'base') };
}

/** The oid a delete compares against. Omitted means "whatever ls-refs shows now". The zero oid is not a tip. */
export function parseDeleteOid(value: unknown): Oid | null {
  if (blank(value)) return null;
  if (value === ZERO_OID) throw fail('bad_request', 'oid must not be the zero oid');
  const oid = parsedOid(value);
  if (!oid) throw fail('bad_request', 'oid must be a 40-hex oid');
  return oid;
}

export function parseExpectedHead(value: unknown): ExpectedHead {
  if (blank(value)) return { kind: 'any' };
  const oid = parsedOid(value);
  if (!oid) throw fail('bad_request', 'head must be a 40-hex oid');
  return { kind: 'oid', oid };
}

function parseHint(value: unknown): Oid | null {
  if (blank(value)) return null;
  const oid = parsedOid(value);
  if (value === ZERO_OID || !oid) throw fail('bad_request', 'hint must be a 40-hex commit id');
  return oid;
}

export function parseMode(value: unknown): BlobMode {
  const found = fromNullable(value);
  if (found.tag === 'none') return MODE_BLOB;
  if (typeof value === 'string' && (BLOB_MODES as readonly string[]).includes(value)) return value as BlobMode;
  throw fail('bad_request', 'mode must be 100644, 100755, or 120000');
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw fail('bad_request', `${field} must be a string`);
  return value;
}

function contentOf(obj: Body): string {
  const content = field(obj, 'content');
  const replace = field(obj, 'replace');
  if (content.tag === 'some' && typeof content.value !== 'string') throw fail('bad_request', 'content must be a string');
  if (replace.tag === 'some' && typeof replace.value !== 'string') throw fail('bad_request', 'replace must be a string');
  if (content.tag === 'some' && replace.tag === 'some' && content.value !== replace.value) throw fail('bad_request', 'content and replace differ');
  if (content.tag === 'some' && typeof content.value === 'string') return content.value;
  if (replace.tag === 'some' && typeof replace.value === 'string') return replace.value;
  return '';
}

function parseOp(obj: Body): Change {
  const op = obj.op;
  if (op === OP_CREATE || op === OP_WRITE) {
    const content = field(obj, 'content');
    return { kind: op, path: text(obj.path, 'path'), content: text(content.tag === 'none' ? '' : content.value, 'content'), mode: parseMode(obj.mode) };
  }
  if (op === OP_EDIT) {
    const find = text(obj.find, 'find');
    if (find === '') throw fail('bad_request', 'edit find must be non-empty; omit find, or use op create, to create a file');
    const replace = field(obj, 'replace');
    return { kind: 'edit', path: text(obj.path, 'path'), find, replace: replace.tag === 'none' ? '' : text(replace.value, 'replace') };
  }
  if (op === OP_DELETE) return { kind: 'delete', path: text(obj.path, 'path') };
  if (op === OP_RENAME) {
    const path = field(obj, 'path');
    const from = path.tag === 'some' ? path.value : obj.from;
    return { kind: 'rename', from: text(from, 'path'), to: text(obj.to, 'to') };
  }
  throw fail('bad_request', `op must be ${OP_CREATE}, ${OP_WRITE}, ${OP_EDIT}, ${OP_DELETE}, or ${OP_RENAME}`);
}

function parseChanges(body: Body): readonly Change[] {
  const changes = field(body, 'changes');
  if (changes.tag === 'some') {
    if (field(body, 'path').tag === 'some' || field(body, 'find').tag === 'some' || field(body, 'to').tag === 'some' || field(body, 'delete').tag === 'some') throw fail('bad_request', 'pass changes or a single path, not both');
    if (!Array.isArray(changes.value) || changes.value.length === 0) throw fail('bad_request', 'changes must be a non-empty array');
    return changes.value.map(item => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) throw fail('bad_request', 'each change must be an object');
      return parseOp(item as Body);
    });
  }
  const path = text(body.path, 'path');
  const deleted = field(body, 'delete');
  if (deleted.tag === 'some' && deleted.value === true) return [{ kind: 'delete', path }];
  if (deleted.tag === 'some') throw fail('bad_request', 'delete must be true');
  const to = field(body, 'to');
  if (to.tag === 'some') return [{ kind: 'rename', from: path, to: text(to.value, 'to') }];
  const find = field(body, 'find');
  const creating = find.tag === 'none' || find.value === '';
  if (creating) return [{ kind: 'create', path, content: contentOf(body), mode: parseMode(body.mode) }];
  if (typeof find.value !== 'string') throw fail('bad_request', 'find must be a string');
  const replace = field(body, 'replace');
  return [{ kind: 'edit', path, find: find.value, replace: replace.tag === 'none' ? '' : text(replace.value, 'replace') }];
}

export function parseEdit(body: Body, now: UnixSeconds): EditRequest {
  const ref = blank(body.ref) ? null : branchRef(body.ref, 'ref');
  const message = text(body.message, 'message');
  if (message.includes('\0')) throw fail('bad_request', 'message must not contain NUL');
  const author = stamp(body.author, 'author', now);
  const committer = field(body, 'committer');
  const stampedCommitter = committer.tag === 'none' ? null : stamp(committer.value, 'committer', now);
  return { ref, base: parseBase(body.base), changes: parseChanges(body), author, committer: stampedCommitter, message, head: parseExpectedHead(body.head), hint: parseHint(body.hint) };
}

export function sameBranch(requested: string, full: string): boolean {
  if (requested === full || requested === 'HEAD') return true;
  return !requested.startsWith('refs/') && full === `refs/heads/${requested}`;
}
