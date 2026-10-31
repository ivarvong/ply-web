// Abbreviated commit ids on read requests. A full object walk is not cheap, so a short oid resolves
// only against refs the server already advertised (branch tips, tag tips, peeled tag commits). Anything
// else is a bad_request that tells the caller to send the full oid.

/** Shortest abbreviation this API will try. Shorter hex stays a ref name. */
export const MIN_ABBREV_HEX = 7;
/** SHA-1 object ids. ply reads only sha1 repositories. */
export const FULL_OID_HEX = 40;

const ABBREV_OID = new RegExp(`^[0-9a-f]{${MIN_ABBREV_HEX},${FULL_OID_HEX - 1}}$`);
const FULL_OID = new RegExp(`^[0-9a-f]{${FULL_OID_HEX}}$`);

/** Prefixes that name the refs a cheap disambiguation may see. One ls-refs, no object walk. */
export const ADVERTISED_REF_PREFIXES = ['HEAD', 'refs/heads/', 'refs/tags/'] as const;

export type AdvertisedRef = { oid: string; peeled?: string };

export type AbbrevMatch =
  | { kind: 'unique'; oid: string }
  | { kind: 'none' | 'ambiguous'; message: string };

export function isAbbreviatedOid(ref: string): boolean {
  return ABBREV_OID.test(ref);
}

export function isFullOid(ref: string): boolean {
  return FULL_OID.test(ref);
}

function fullOidRequired(prefix: string, why: string): string {
  return `abbreviated oid ${prefix} ${why}; pass a full ${FULL_OID_HEX}-hex oid`;
}

/** Unique advertised oid (the ref oid or its peeled commit) for `prefix`, or a bad_request message. */
export function matchAbbreviatedOid(prefix: string, refs: Iterable<readonly [string, AdvertisedRef]>): AbbrevMatch {
  const hits = new Set<string>();
  for (const [, rec] of refs) {
    const oid = rec.oid.toLowerCase();
    if (oid.startsWith(prefix)) hits.add(oid);
    const peeled = rec.peeled?.toLowerCase();
    if (peeled && peeled.startsWith(prefix)) hits.add(peeled);
  }
  if (hits.size === 1) {
    const oid = hits.values().next().value;
    if (oid) return { kind: 'unique', oid };
  }
  if (hits.size > 1) return { kind: 'ambiguous', message: fullOidRequired(prefix, `matches ${hits.size} advertised commits`) };
  return { kind: 'none', message: fullOidRequired(prefix, 'matches no advertised ref') };
}
