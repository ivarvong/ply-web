// HEAD, including an unborn symref. ply's lsRefs does not send the `unborn` argument and drops `unborn` lines
// (src/lsrefs.js: an unborn line parses as null), so an empty repository's HEAD — which git reports as
// `unborn HEAD symref-target:refs/heads/main` — is invisible through it. This speaks that one ls-refs itself.
import { fail, pkts } from 'ply';
import { KIND } from 'ply';
import { LS_REFS_COMMAND, LS_REFS_DELIM_AFTER, LS_REFS_SYMREF_TARGET, LS_REFS_UNBORN } from './constants.ts';
import { asOid, type Oid } from './oid.ts';

export type HeadState =
  | { readonly kind: 'born'; readonly ref: string; readonly oid: Oid }
  | { readonly kind: 'detached'; readonly oid: Oid }
  | { readonly kind: 'unborn'; readonly ref: string }
  | { readonly kind: 'absent' };

type Frame = { kind: string; payload?: Uint8Array };
type Span = { set: (attrs: Record<string, unknown>) => unknown };
export type HeadTransport = {
  parent: unknown;
  tracer: { span: (name: string, opts: object, fn: (span: Span) => Promise<HeadState>) => Promise<HeadState> };
  frames: (service: string, body: Uint8Array, span: Span) => AsyncIterable<Frame>;
};

const HEAD = 'HEAD';
const ERR = 'ERR ';
const textDecoder = new TextDecoder();

export function unbornLsRefsBody(): Uint8Array {
  return pkts([
    LS_REFS_COMMAND,
    'peel\n',
    'symrefs\n',
    `${LS_REFS_UNBORN}\n`,
    `ref-prefix ${HEAD}\n`,
  ], { delimAfter: LS_REFS_DELIM_AFTER }) as Uint8Array;
}

function lineOf(payload: Uint8Array): string {
  const text = textDecoder.decode(payload);
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

type Listed =
  | { readonly kind: 'unborn'; readonly name: string; readonly target: string | null }
  | { readonly kind: 'ref'; readonly oid: Oid; readonly name: string; readonly target: string | null };

export function parseHeadLine(line: string): Listed {
  if (line.startsWith(ERR)) throw fail('remote_error', `remote: ${line.slice(ERR.length)}`);
  const sp = line.indexOf(' ');
  if (sp < 0) throw fail('protocol', `ls-refs: malformed line ${JSON.stringify(line.slice(0, 60))}`);
  const first = line.slice(0, sp);
  const rest = line.slice(sp + 1);
  const cut = rest.indexOf(' ');
  const name = cut < 0 ? rest : rest.slice(0, cut);
  const attrs = cut < 0 ? '' : rest.slice(cut + 1);
  const targetAttr = attrs.split(' ').find(a => a.startsWith(LS_REFS_SYMREF_TARGET));
  const target = targetAttr ? targetAttr.slice(LS_REFS_SYMREF_TARGET.length) : null;
  if (first === LS_REFS_UNBORN) return { kind: 'unborn', name, target };
  return { kind: 'ref', oid: asOid(first.toLowerCase()), name, target };
}

export function headFromLines(lines: readonly Listed[]): HeadState {
  const head = lines.find(l => l.name === HEAD);
  if (!head) return { kind: 'absent' };
  if (head.kind === 'unborn') {
    if (!head.target) throw fail('protocol', 'unborn HEAD without a symref-target');
    return { kind: 'unborn', ref: head.target };
  }
  if (head.target) return { kind: 'born', ref: head.target, oid: head.oid };
  return { kind: 'detached', oid: head.oid };
}

export async function readHead(t: HeadTransport): Promise<HeadState> {
  return t.tracer.span('git.head', {
    parent: t.parent,
    kind: KIND.CLIENT,
    attrs: { 'git.command': 'ls-refs', 'git.ls_refs.unborn': true, 'git.ls_refs.prefixes': [HEAD] },
  }, async span => {
    const lines: Listed[] = [];
    let ended = false;
    for await (const frame of t.frames('git-upload-pack', unbornLsRefsBody(), span)) {
      if (ended) throw fail('protocol', `ls-refs: ${frame.kind} after the terminating flush-pkt`);
      if (frame.kind === 'flush') { ended = true; continue; }
      if (frame.kind !== 'data' || !frame.payload) throw fail('protocol', `ls-refs: unexpected ${frame.kind} in ref listing`);
      lines.push(parseHeadLine(lineOf(frame.payload)));
    }
    if (!ended) throw fail('protocol', 'ls-refs: response ended without the terminating flush-pkt');
    const head = headFromLines(lines);
    span.set({
      'git.head.kind': head.kind,
      'git.head.ref': head.kind === 'born' || head.kind === 'unborn' ? head.ref : '',
      'git.head.oid': head.kind === 'born' || head.kind === 'detached' ? head.oid : '',
    });
    return head;
  });
}
