// The oid a ref advertises right now, and the code on a thrown ply error.
// A missing ref is null. An empty oid stays empty, so a compare-and-swap fallback can tell the two apart.
import { lsRefs } from 'ply'
import { chainGet, mapGet } from '../absent.ts'
import { type GitTransport } from './call.ts'

export async function advertisedOid(t: GitTransport, ref: string): Promise<string | null> {
  const listed = mapGet((await lsRefs(t, [ref])).refs, ref)
  if (listed.tag === 'none') return null
  return listed.value.oid
}

export function hasErrorCode(err: unknown, code: string): boolean {
  const found = chainGet(err, 'code')
  return found.tag === 'some' && found.value === code
}
