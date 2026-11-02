// The oid a ref advertises right now. A missing ref is null. An empty oid stays empty, so a compare-and-swap
// fallback can tell the two apart. A failed ls-refs is ply's Err, returned to the caller.
import { lsRefs } from 'ply'
import { mapGet } from '../absent.ts'
import { type Result } from '../http/machine.ts'
import { type PlyError } from '../ply-result.ts'
import { type GitTransport } from './call.ts'

export async function advertisedOid(t: GitTransport, ref: string): Promise<Result<string | null, PlyError>> {
  const listed = await lsRefs(t, [ref])
  if (!listed.ok) return listed
  const found = mapGet(listed.value.refs, ref)
  return { ok: true, value: found.tag === 'none' ? null : found.value.oid }
}
