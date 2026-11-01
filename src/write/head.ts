// HEAD, including an unborn symref, as ply's lsRefs reports it.
//
// Asking for `unborn` costs one advertisement GET the first time an origin is seen in this isolate: ply sends the
// argument only when discover() shows `ls-refs=unborn`, which is git's own rule (connect.c server_supports_feature).
// The bit is a fact about the server. It is remembered here and passed back as `info`, the option ply provides so a
// discover result already in hand does not fetch the advertisement again. A later HEAD read on that origin is one
// ls-refs. The first is discover + ls-refs. Sending `unborn` without that check would be this module speaking the
// protocol, which is the code this adapter replaced.
import { discover, KIND, lsRefs, parseOid, type Oid, type Span } from 'ply';
import { mapGet } from '../absent.ts';
import { type GitTransport } from './call.ts';

export type HeadState =
  | { readonly kind: 'born'; readonly ref: string; readonly oid: Oid }
  | { readonly kind: 'detached'; readonly oid: Oid }
  | { readonly kind: 'unborn'; readonly ref: string }
  | { readonly kind: 'absent' };

/** What `lsRefs` returns that decides HEAD. Structural so a listing can be built in a test. */
export type HeadListing = {
  readonly refs: ReadonlyMap<string, { readonly oid: string }>;
  readonly head: string | null;
  readonly unborn: { readonly target: string } | null;
};

const HEAD_NAME = 'HEAD';
const DISCOVER_FETCHED = 'discover';
const DISCOVER_CACHED = 'cached';

/** Origins whose `ls-refs=unborn` advertisement this isolate has already read. Same bound as the quirks map. */
const MAX_UNBORN_ORIGINS = 256;
const unbornAdvertised = new Map<string, boolean>();
const unbornInflight = new Map<string, Promise<boolean>>();

type DiscoverSource = typeof DISCOVER_FETCHED | typeof DISCOVER_CACHED;

function rememberUnborn(origin: string, advertised: boolean): boolean {
  if (!unbornAdvertised.has(origin) && unbornAdvertised.size >= MAX_UNBORN_ORIGINS) unbornAdvertised.clear();
  unbornAdvertised.set(origin, advertised);
  return advertised;
}

/**
 * ply's readCommit learns `ls-refs=unborn` while answering an empty repository, and does not tell this cache.
 * Record the bit so a later HEAD read in this isolate is ls-refs only, the same as a readHead that discovered it.
 */
export function noteUnbornAdvertised(url: string): void {
  rememberUnborn(new URL(url).origin, true);
}

/** ply's `lsRefsUnborn` for this origin: one discover per isolate, then the cached bit. */
async function lsRefsUnbornOf(t: GitTransport): Promise<{ readonly advertised: boolean; readonly source: DiscoverSource }> {
  const origin = new URL(t.url).origin;
  const known = mapGet(unbornAdvertised, origin);
  if (known.tag === 'some') return { advertised: known.value, source: DISCOVER_CACHED };
  let flight = unbornInflight.get(origin);
  if (!flight) {
    flight = discover(t).then(info => rememberUnborn(origin, info.lsRefsUnborn)).finally(() => { unbornInflight.delete(origin); });
    unbornInflight.set(origin, flight);
  }
  return { advertised: await flight, source: DISCOVER_FETCHED };
}

/**
 * unborn wins (an empty repository). A listed HEAD with a symref target is born. A listed HEAD with no target is
 * detached. Anything else is absent, including a server that does not advertise `ls-refs=unborn`.
 */
function oidOf(value: string): Oid {
  const parsed = parseOid(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

export function headFromListing(listed: HeadListing): HeadState {
  if (listed.unborn) return { kind: 'unborn', ref: listed.unborn.target };
  const rec = listed.refs.get(HEAD_NAME);
  if (rec && listed.head !== null) return { kind: 'born', ref: listed.head, oid: oidOf(rec.oid) };
  if (rec) return { kind: 'detached', oid: oidOf(rec.oid) };
  return { kind: 'absent' };
}

export async function readHead(t: GitTransport): Promise<HeadState> {
  return t.tracer.span('git.head', {
    parent: t.parent,
    kind: KIND.CLIENT,
    attrs: { 'git.command': 'ls-refs', 'git.ls_refs.unborn': true, 'git.ls_refs.prefixes': [HEAD_NAME] },
  }, async (span: Span) => {
    const cap = await lsRefsUnbornOf(t);
    const listed = await lsRefs(t, [HEAD_NAME], { unborn: true, info: { lsRefsUnborn: cap.advertised } });
    const head = headFromListing(listed);
    span.set({
      'git.head.kind': head.kind,
      'git.head.ref': head.kind === 'born' || head.kind === 'unborn' ? head.ref : '',
      'git.head.discover': cap.source,
      'git.head.unborn_advertised': cap.advertised,
      'git.head.oid': head.kind === 'born' || head.kind === 'detached' ? head.oid : '',
    });
    return head;
  });
}
