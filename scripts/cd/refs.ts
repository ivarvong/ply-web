export type ApiRefs = {
  readonly head: string | null
  readonly refs: Readonly<Record<string, string>>
  readonly peeled?: Readonly<Record<string, string>>
}

export type RefJudgement = { readonly ok: true } | { readonly ok: false; readonly detail: string }

const OID = /^[0-9a-f]{40}$/

export function parseShowRef(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{40})\s+(\S+)$/.exec(line.trim())
    if (match?.[1] && match[2]) map.set(match[2], match[1])
  }
  return map
}

/** Exit 0, and no error/fatal/missing/bad/corrupt/broken line. Dangling and unreachable objects are allowed. */
export function judgeFsck(code: number, stdout: string, stderr: string): RefJudgement {
  if (code !== 0) return { ok: false, detail: `git fsck exited ${code}` }
  for (const line of `${stdout}\n${stderr}`.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || /dangling|unreachable/i.test(trimmed)) continue
    if (/\b(error|fatal|missing|bad|corrupt|broken)\b/i.test(trimmed)) return { ok: false, detail: trimmed }
  }
  return { ok: true }
}

/**
 * `/v1/refs` against `git show-ref`, `git rev-parse ref^{}`, and `git symbolic-ref HEAD`.
 * An annotated tag's ref oid is the tag object. The peeled commit is a separate map.
 */
export function judgeRefs(
  api: ApiRefs,
  showRef: ReadonlyMap<string, string>,
  peeled: ReadonlyMap<string, string>,
  symbolicHead: string,
): RefJudgement {
  if (api.head !== symbolicHead) return { ok: false, detail: `head ${api.head ?? 'null'}, git symbolic-ref ${symbolicHead}` }
  for (const [name, oid] of showRef) {
    if (api.refs[name] !== oid) return { ok: false, detail: `${name} is ${api.refs[name] ?? 'absent'} in /v1/refs and ${oid} in git` }
  }
  for (const [name, oid] of Object.entries(api.refs)) {
    if (showRef.get(name) !== oid) return { ok: false, detail: `${name} is ${oid} in /v1/refs and ${showRef.get(name) ?? 'absent'} in git` }
  }
  for (const [name, oid] of peeled) {
    if (!OID.test(oid)) return { ok: false, detail: `${name} peeled to ${oid}` }
    const target = showRef.get(name)
    if (target === undefined) return { ok: false, detail: `${name} peeled but is not a ref` }
    if (oid === target) {
      if (api.peeled && name in api.peeled && api.peeled[name] !== oid) {
        return { ok: false, detail: `${name} peeled to its own oid but /v1/refs says ${api.peeled[name]}` }
      }
      continue
    }
    if (api.peeled?.[name] !== oid) {
      return { ok: false, detail: `${name} peels to ${oid}, /v1/refs peeled ${api.peeled?.[name] ?? 'absent'}` }
    }
    if (api.refs[name] === oid) return { ok: false, detail: `${name} returned the peeled commit instead of the tag object` }
  }
  for (const [name, oid] of Object.entries(api.peeled ?? {})) {
    if (peeled.get(name) !== oid) return { ok: false, detail: `${name} peeled ${oid} in /v1/refs and ${peeled.get(name) ?? 'absent'} in git` }
  }
  return { ok: true }
}
