// Pure reading of a write body. Every rejection here is bad_request and happens before any fetch.
import { fail, validateRef } from 'ply';
import { BLOB_MODES, MODE_BLOB, OP_CREATE, OP_DELETE, OP_EDIT, OP_RENAME, OP_WRITE } from './constants.ts';
import { stamp, type Stamp, type UnixSeconds } from './identity.ts';
import { asOid, isOid, isZeroOid, type Oid } from './oid.ts';

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
  if (isZeroOid(value)) throw fail('bad_request', `${field} must not be the zero oid`);
  if (isOid(value)) throw fail('bad_request', `${field} must be a branch name, not a commit id`);
  return validateRef(fullRef(value)) as string;
}

export function tagRef(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw fail('bad_request', 'name is required');
  if (isOid(value) || isZeroOid(value)) throw fail('bad_request', 'name must be a tag name, not an object id');
  const full = value.startsWith('refs/tags/') ? value : `refs/tags/${value}`;
  return validateRef(full) as string;
}

export function parseBase(value: unknown): BaseSpec {
  if (value === undefined || value === null || value === '') return { kind: 'omit' };
  if (typeof value !== 'string') throw fail('bad_request', 'base must be a branch name or a 40-hex commit id');
  if (isZeroOid(value)) throw fail('bad_request', 'base must not be the zero oid; omit base to create a root commit');
  if (isOid(value)) return { kind: 'oid', oid: asOid(value) };
  return { kind: 'ref', ref: branchRef(value, 'base') };
}

/** The oid a delete compares against. Omitted means "whatever ls-refs shows now". The zero oid is not a tip. */
export function parseDeleteOid(value: unknown): Oid | null {
  if (value === undefined || value === null || value === '') return null;
  if (isZeroOid(value)) throw fail('bad_request', 'oid must not be the zero oid');
  if (!isOid(value)) throw fail('bad_request', 'oid must be a 40-hex oid');
  return asOid(value);
}

export function parseExpectedHead(value: unknown): ExpectedHead {
  if (value === undefined || value === null || value === '') return { kind: 'any' };
  if (!isOid(value)) throw fail('bad_request', 'head must be a 40-hex oid');
  return { kind: 'oid', oid: asOid(value) };
}

function parseHint(value: unknown): Oid | null {
  if (value === undefined || value === null || value === '') return null;
  if (isZeroOid(value) || !isOid(value)) throw fail('bad_request', 'hint must be a 40-hex commit id');
  return asOid(value);
}

export function parseMode(value: unknown): BlobMode {
  if (value === undefined || value === null) return MODE_BLOB;
  if (typeof value === 'string' && (BLOB_MODES as readonly string[]).includes(value)) return value as BlobMode;
  throw fail('bad_request', 'mode must be 100644, 100755, or 120000');
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw fail('bad_request', `${field} must be a string`);
  return value;
}

function contentOf(obj: Body): string {
  const hasContent = obj.content !== undefined;
  const hasReplace = obj.replace !== undefined;
  if (hasContent && typeof obj.content !== 'string') throw fail('bad_request', 'content must be a string');
  if (hasReplace && typeof obj.replace !== 'string') throw fail('bad_request', 'replace must be a string');
  if (hasContent && hasReplace && obj.content !== obj.replace) throw fail('bad_request', 'content and replace differ');
  if (hasContent) return obj.content as string;
  if (hasReplace) return obj.replace as string;
  return '';
}

function parseOp(obj: Body): Change {
  const op = obj.op;
  if (op === OP_CREATE || op === OP_WRITE) {
    return { kind: op, path: text(obj.path, 'path'), content: text(obj.content === undefined ? '' : obj.content, 'content'), mode: parseMode(obj.mode) };
  }
  if (op === OP_EDIT) {
    const find = text(obj.find, 'find');
    if (find === '') throw fail('bad_request', 'edit find must be non-empty; omit find, or use op create, to create a file');
    const replace = obj.replace === undefined ? '' : text(obj.replace, 'replace');
    return { kind: 'edit', path: text(obj.path, 'path'), find, replace };
  }
  if (op === OP_DELETE) return { kind: 'delete', path: text(obj.path, 'path') };
  if (op === OP_RENAME) {
    const from = obj.path !== undefined ? obj.path : obj.from;
    return { kind: 'rename', from: text(from, 'path'), to: text(obj.to, 'to') };
  }
  throw fail('bad_request', `op must be ${OP_CREATE}, ${OP_WRITE}, ${OP_EDIT}, ${OP_DELETE}, or ${OP_RENAME}`);
}

function parseChanges(body: Body): readonly Change[] {
  if (body.changes !== undefined) {
    if (body.path !== undefined || body.find !== undefined || body.to !== undefined || body.delete !== undefined) throw fail('bad_request', 'pass changes or a single path, not both');
    if (!Array.isArray(body.changes) || body.changes.length === 0) throw fail('bad_request', 'changes must be a non-empty array');
    return body.changes.map(item => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) throw fail('bad_request', 'each change must be an object');
      return parseOp(item as Body);
    });
  }
  const path = text(body.path, 'path');
  if (body.delete === true) return [{ kind: 'delete', path }];
  if (body.delete !== undefined) throw fail('bad_request', 'delete must be true');
  if (body.to !== undefined) return [{ kind: 'rename', from: path, to: text(body.to, 'to') }];
  const creating = body.find === undefined || body.find === '';
  if (creating) return [{ kind: 'create', path, content: contentOf(body), mode: parseMode(body.mode) }];
  if (typeof body.find !== 'string') throw fail('bad_request', 'find must be a string');
  const replace = body.replace === undefined ? '' : text(body.replace, 'replace');
  return [{ kind: 'edit', path, find: body.find, replace }];
}

export function parseEdit(body: Body, now: UnixSeconds): EditRequest {
  const ref = body.ref === undefined || body.ref === null || body.ref === '' ? null : branchRef(body.ref, 'ref');
  const message = text(body.message, 'message');
  if (message.includes('\0')) throw fail('bad_request', 'message must not contain NUL');
  const author = stamp(body.author, 'author', now);
  const committer = body.committer === undefined ? null : stamp(body.committer, 'committer', now);
  return { ref, base: parseBase(body.base), changes: parseChanges(body), author, committer, message, head: parseExpectedHead(body.head), hint: parseHint(body.hint) };
}

export function sameBranch(requested: string, full: string): boolean {
  if (requested === full || requested === 'HEAD') return true;
  return !requested.startsWith('refs/') && full === `refs/heads/${requested}`;
}
