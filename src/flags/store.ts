// R2 compare-and-swap. A lost race returns a conflict and does not apply the caller's bytes.
// The object's ETag is the revision. There is one key.
import { murmur3_32 } from './hash.ts';
import { ABSENT_REVISION, FLAGS_OBJECT_KEY } from './ttl.ts';
import { diffDocuments, encodeDocument, parseDocumentText } from './document.ts';
import type { DiffEntry, FlagDocument, ReadResult, WriteResult } from './types.ts';

export type StoredObject = { readonly etag: string; readonly body: string };

export type PutCondition =
  | { readonly kind: 'etagMatches'; readonly etag: string }
  | { readonly kind: 'absent' };

export type FlagStore = {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: string, condition: PutCondition): Promise<StoredObject | null>;
};

export type R2Object = { etag: string; httpEtag?: string; text(): Promise<string> };
export type R2Put = { etag: string; httpEtag?: string } | null;
export type R2BucketLike = {
  get(key: string): Promise<R2Object | null>;
  put(key: string, value: string, options?: { onlyIf?: { etagMatches: string } | Headers; httpMetadata?: { contentType: string } }): Promise<R2Put>;
};

function quoted(etag: string, httpEtag: string | undefined): string {
  if (httpEtag && httpEtag.length > 0) return httpEtag;
  return etag.startsWith('"') ? etag : `"${etag}"`;
}

function unquote(etag: string): string {
  const match = /^"(.*)"$/.exec(etag);
  return match?.[1] ?? etag;
}

function etagFor(body: string): string {
  return `"${murmur3_32(new TextEncoder().encode(body), 0).toString(16).padStart(8, '0')}"`;
}

/** In-memory CAS with the same absent / etagMatches rules as the R2 adapter. Tests and the propagation bench use it. */
export function memoryStore(initial: StoredObject | null = null): FlagStore & { snapshot(): StoredObject | null } {
  let current = initial;
  return {
    snapshot: () => current,
    async get() {
      return current;
    },
    async put(_key, body, condition) {
      if (condition.kind === 'absent') {
        if (current) return null;
      } else if (!current || current.etag !== condition.etag) {
        return null;
      }
      current = { etag: etagFor(body), body };
      return current;
    },
  };
}

/** Adapter over the Workers R2 binding. `etagMatches` uses the raw etag; callers pass the quoted revision. */
export function r2Store(bucket: R2BucketLike): FlagStore {
  return {
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return { etag: quoted(object.etag, object.httpEtag), body: await object.text() };
    },
    async put(key, body, condition) {
      const onlyIf = condition.kind === 'etagMatches'
        ? { etagMatches: unquote(condition.etag) }
        : new Headers({ 'if-none-match': '*' });
      const stored = await bucket.put(key, body, { onlyIf, httpMetadata: { contentType: 'application/json' } });
      if (!stored) return null;
      return { etag: quoted(stored.etag, stored.httpEtag), body };
    },
  };
}

export type InvalidateResult = { readonly kind: 'ok' } | { readonly kind: 'failed'; readonly reason: string };

export type Invalidator = {
  invalidate(): Promise<InvalidateResult>;
};

export type WriteLog = {
  readonly op: 'setRollout' | 'setTargeting';
  readonly flag: string;
  readonly oldRevision: string | null;
  readonly newRevision: string;
  readonly diff: readonly DiffEntry[];
  readonly invalidated: boolean;
};

async function readCurrent(store: FlagStore): Promise<{ readonly kind: 'absent' } | { readonly kind: 'ok'; readonly revision: string; readonly document: FlagDocument } | { readonly kind: 'invalid'; readonly revision: string; readonly reason: string } | { readonly kind: 'unavailable'; readonly reason: string }> {
  let stored: StoredObject | null;
  try {
    stored = await store.get(FLAGS_OBJECT_KEY);
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : 'flag store read failed' };
  }
  if (!stored) return { kind: 'absent' };
  const parsed = parseDocumentText(stored.body);
  if (parsed.kind === 'invalid') return { kind: 'invalid', revision: stored.etag, reason: parsed.reason };
  return { kind: 'ok', revision: stored.etag, document: parsed.document };
}

export async function readConfig(store: FlagStore): Promise<ReadResult> {
  const current = await readCurrent(store);
  if (current.kind === 'absent') return { kind: 'absent' };
  if (current.kind === 'unavailable') return current;
  if (current.kind === 'invalid') return current;
  return { kind: 'ok', revision: current.revision, config: current.document };
}

export async function commitChange(
  store: FlagStore,
  invalidator: Invalidator,
  expectedRevision: string,
  edit: (document: FlagDocument) => { readonly kind: 'ok'; readonly document: FlagDocument } | { readonly kind: 'invalid'; readonly reason: string },
  op: WriteLog['op'],
  flag: string,
  log: (entry: WriteLog) => void = () => {},
): Promise<WriteResult> {
  const current = await readCurrent(store);
  if (current.kind === 'unavailable') return current;
  if (current.kind === 'invalid') return current;
  if (expectedRevision === ABSENT_REVISION) {
    if (current.kind !== 'absent') return { kind: 'conflict', expected: ABSENT_REVISION, actual: current.revision };
  } else if (current.kind === 'absent') {
    return { kind: 'conflict', expected: expectedRevision, actual: null };
  } else if (current.revision !== expectedRevision) {
    return { kind: 'conflict', expected: expectedRevision, actual: current.revision };
  }
  const base = current.kind === 'ok' ? current.document : { environment: 'production' as const, flags: [] };
  const edited = edit(base);
  if (edited.kind === 'invalid') return { kind: 'invalid', reason: edited.reason, revision: current.kind === 'ok' ? current.revision : null };
  const body = encodeDocument(edited.document);
  if (current.kind === 'ok' && body === encodeDocument(current.document)) {
    return { kind: 'ok', revision: current.revision, config: current.document, unchanged: true, invalidated: true };
  }
  const condition = expectedRevision === ABSENT_REVISION ? { kind: 'absent' as const } : { kind: 'etagMatches' as const, etag: expectedRevision };
  let stored: StoredObject | null;
  try {
    stored = await store.put(FLAGS_OBJECT_KEY, body, condition);
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : 'flag store write failed' };
  }
  if (!stored) {
    const again = await readCurrent(store);
    const actual = again.kind === 'ok' || again.kind === 'invalid' ? again.revision : null;
    return { kind: 'conflict', expected: expectedRevision, actual };
  }
  const invalidated = await invalidator.invalidate();
  const diff = diffDocuments(base, edited.document);
  log({ op, flag, oldRevision: current.kind === 'ok' ? current.revision : null, newRevision: stored.etag, diff, invalidated: invalidated.kind === 'ok' });
  return { kind: 'ok', revision: stored.etag, config: edited.document, unchanged: false, invalidated: invalidated.kind === 'ok' };
}
