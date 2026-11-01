import { judgeFlagStep } from './flags-smoke.ts'
import { asRecord } from './json.ts'

export type Saved = Readonly<Record<string, string>>

export type RayNeed = 'required' | 'optional' | 'absent'

const RAY_ENTRY = /^([a-z-]+)=([0-9a-f]{16}-[A-Z]{3}|-|no-response);dur=\d+$/
const PHASES = new Set(['ls-refs', 'fetch', 'receive-pack'])
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BUILD = /^ply=[0-9a-f]{40} ply-web=[0-9a-f]{40}$/

export type Expect =
  | { readonly kind: 'empty-commit' }
  | { readonly kind: 'refs-empty' }
  | { readonly kind: 'code'; readonly status: number; readonly code: string; readonly message?: RegExp }
  | {
      readonly kind: 'outcome'
      readonly status: number
      readonly outcome: string
      readonly noop?: boolean
      readonly nullFields?: readonly string[]
      readonly equals?: readonly { readonly field: string; readonly key: string }[]
      readonly differs?: readonly { readonly field: string; readonly key: string }[]
    }
  | { readonly kind: 'text'; readonly status: number; readonly text: string }
  | { readonly kind: 'tree'; readonly names: readonly string[] }
  | { readonly kind: 'parents'; readonly count: number; readonly oidEquals?: string }
  | { readonly kind: 'born' }
  | { readonly kind: 'stamps'; readonly authorEmail: string; readonly committerEmail: string }
  | { readonly kind: 'refs-final'; readonly has: readonly string[]; readonly missing: readonly string[]; readonly head: string }
  | { readonly kind: 'flags-rules' }
  | { readonly kind: 'flags-eval' }
  | { readonly kind: 'usage-off' }

export type CallHeaders = {
  readonly requestId: string | null
  readonly build: string | null
  readonly version: string | null
  readonly ray: string | null
  readonly cacheControl?: string | null
  readonly contentType?: string | null
}

export type CallInput = {
  readonly status: number
  readonly bodyText: string
  readonly headers: CallHeaders
  readonly ray: RayNeed
  readonly rayIncludes?: string
  readonly version: string | null
  readonly expect: Expect
  readonly save?: readonly { readonly key: string; readonly field: string }[]
  readonly secrets: readonly string[]
}

export type Judgement =
  | { readonly kind: 'ok'; readonly detail: string; readonly save: Saved }
  | { readonly kind: 'fail'; readonly detail: string }

export function judgeRay(header: string | null, need: RayNeed, includes?: string): string | null {
  if (header === null || header === '') {
    if (need === 'required') return 'missing x-artifacts-ray'
    return null
  }
  if (need === 'absent') return 'x-artifacts-ray was set before the Worker talked to upstream'
  if (header.includes('/')) return 'x-artifacts-ray contains a slash'
  let overflow = 0
  for (const part of header.split(', ')) {
    if (/^overflow=\d+$/.test(part)) {
      overflow += 1
      continue
    }
    const match = RAY_ENTRY.exec(part)
    if (!match || !PHASES.has(match[1] ?? '')) return `bad x-artifacts-ray entry ${part}`
  }
  if (overflow > 1) return 'x-artifacts-ray has more than one overflow'
  if (includes && !header.includes(includes)) return `x-artifacts-ray missing ${includes}`
  return null
}

function leak(text: string, secrets: readonly string[]): string | null {
  for (const secret of secrets) {
    if (secret.length >= 8 && text.includes(secret)) return 'response contains a secret'
  }
  return null
}

function jsonBody(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

function sameNames(got: readonly string[], want: readonly string[]): boolean {
  if (got.length !== want.length) return false
  const left = [...got].sort()
  const right = [...want].sort()
  return left.every((name, i) => name === right[i])
}

function emptyCommit(body: Record<string, unknown>): boolean {
  return body.empty === true
    && body.ref === 'refs/heads/main'
    && body.oid === null
    && body.tree === null
    && Array.isArray(body.parents)
    && body.parents.length === 0
    && body.author === null
    && body.committer === null
    && body.message === null
    && body.signed === false
}

function flagHeaders(input: CallInput) {
  return {
    cacheControl: input.headers.cacheControl ?? null,
    contentType: input.headers.contentType ?? null,
  }
}

function checkExpect(input: CallInput, body: Record<string, unknown> | null, saved: Saved): string | null {
  const expect = input.expect
  if (expect.kind === 'flags-rules' || expect.kind === 'flags-eval' || expect.kind === 'usage-off') {
    const judged = judgeFlagStep(expect.kind, input.status, input.bodyText, flagHeaders(input), saved)
    return judged.kind === 'fail' ? judged.detail : null
  }
  if (expect.kind === 'text') {
    if (input.status !== expect.status) return `status ${input.status}, wanted ${expect.status}`
    if (input.bodyText !== expect.text) return `body ${JSON.stringify(input.bodyText)}, wanted ${JSON.stringify(expect.text)}`
    return null
  }
  if (!body) return 'response is not a JSON object'
  if (expect.kind === 'empty-commit') {
    if (input.status !== 200) return `status ${input.status}, wanted 200`
    if (!emptyCommit(body)) return `empty commit body ${JSON.stringify(body)}`
    return null
  }
  if (expect.kind === 'refs-empty') {
    if (input.status !== 200) return `status ${input.status}, wanted 200`
    if (body.empty !== true || body.head !== null || body.unborn !== 'refs/heads/main') {
      return `refs body ${JSON.stringify(body)}`
    }
    return null
  }
  if (expect.kind === 'code') {
    if (input.status !== expect.status) return `status ${input.status}, wanted ${expect.status}`
    if (body.code !== expect.code) return `code ${String(body.code)}, wanted ${expect.code}`
    if (expect.message && (typeof body.message !== 'string' || !expect.message.test(body.message))) {
      return `message ${JSON.stringify(body.message)}`
    }
    return null
  }
  if (expect.kind === 'outcome') {
    if (input.status !== expect.status) return `status ${input.status}, wanted ${expect.status}`
    if (body.outcome !== expect.outcome) return `outcome ${String(body.outcome)}, wanted ${expect.outcome}`
    if (expect.noop !== undefined && body.noop !== expect.noop) return `noop ${String(body.noop)}, wanted ${String(expect.noop)}`
    for (const field of expect.nullFields ?? []) {
      if (body[field] !== null) return `${field} is ${JSON.stringify(body[field])}, wanted null`
    }
    for (const eq of expect.equals ?? []) {
      const want = saved[eq.key]
      if (want === undefined) return `saved ${eq.key} is missing`
      if (body[eq.field] !== want) return `${eq.field} is ${JSON.stringify(body[eq.field])}, wanted ${want}`
    }
    for (const diff of expect.differs ?? []) {
      const other = saved[diff.key]
      if (other === undefined) return `saved ${diff.key} is missing`
      if (body[diff.field] === other) return `${diff.field} still equals ${other}`
    }
    return null
  }
  if (expect.kind === 'tree') {
    if (input.status !== 200) return `status ${input.status}, wanted 200`
    if (!Array.isArray(body.entries)) return 'tree has no entries'
    const names = body.entries.map(entry => {
      const rec = asRecord(entry)
      return rec && typeof rec.name === 'string' ? rec.name : ''
    })
    if (!sameNames(names, expect.names)) return `tree names ${names.join(', ')}`
    return null
  }
  if (expect.kind === 'parents') {
    if (input.status !== 200) return `status ${input.status}, wanted 200`
    if (!Array.isArray(body.parents) || body.parents.length !== expect.count) {
      return `parents ${JSON.stringify(body.parents)}, wanted ${expect.count}`
    }
    if (expect.oidEquals) {
      const want = saved[expect.oidEquals]
      if (want === undefined) return `saved ${expect.oidEquals} is missing`
      if (body.oid !== want) return `oid is ${JSON.stringify(body.oid)}, wanted ${want}`
    }
    return null
  }
  if (expect.kind === 'born') {
    if (input.status !== 200) return `status ${input.status}, wanted 200`
    if (typeof body.oid !== 'string' || !/^[0-9a-f]{40}$/.test(body.oid)) return `oid ${JSON.stringify(body.oid)}`
    return null
  }
  if (expect.kind === 'stamps') {
    if (input.status !== 200) return `status ${input.status}, wanted 200`
    const author = asRecord(body.author)
    const committer = asRecord(body.committer)
    if (author?.email !== expect.authorEmail) return `author ${JSON.stringify(body.author)}`
    if (committer?.email !== expect.committerEmail) return `committer ${JSON.stringify(body.committer)}`
    return null
  }
  if (input.status !== 200) return `status ${input.status}, wanted 200`
  const refs = asRecord(body.refs)
  if (!refs) return 'refs is not an object'
  if (body.head !== expect.head) return `head ${JSON.stringify(body.head)}, wanted ${expect.head}`
  for (const name of expect.has) {
    if (typeof refs[name] !== 'string') return `missing ${name}`
  }
  for (const name of expect.missing) {
    if (name in refs) return `${name} is still present`
  }
  return null
}

export function judgeCall(input: CallInput, saved: Saved): Judgement {
  const leaked = leak(input.bodyText, input.secrets)
    ?? leak(input.headers.ray ?? '', input.secrets)
    ?? leak(input.headers.requestId ?? '', input.secrets)
  if (leaked) return { kind: 'fail', detail: leaked }
  if (!input.headers.requestId || !REQUEST_ID.test(input.headers.requestId)) {
    return { kind: 'fail', detail: 'x-ply-request-id is not a uuid' }
  }
  if (!input.headers.build || !BUILD.test(input.headers.build)) {
    return { kind: 'fail', detail: 'x-ply-build is not ply=<sha> ply-web=<sha>' }
  }
  if (input.version !== null && input.headers.version !== input.version) {
    return { kind: 'fail', detail: `x-ply-version ${input.headers.version ?? 'missing'}, wanted ${input.version}` }
  }
  const ray = judgeRay(input.headers.ray, input.ray, input.rayIncludes)
  if (ray) return { kind: 'fail', detail: ray }
  const body = input.expect.kind === 'text' ? null : jsonBody(input.bodyText)
  const problem = checkExpect(input, body, saved)
  if (problem) return { kind: 'fail', detail: problem }
  const next: Record<string, string> = {}
  const flag = judgeFlagStep(input.expect.kind, input.status, input.bodyText, flagHeaders(input), saved)
  if (flag.kind === 'ok') Object.assign(next, flag.save)
  if (body) {
    for (const item of input.save ?? []) {
      const value = body[item.field]
      if (typeof value !== 'string' || value === '') return { kind: 'fail', detail: `cannot save ${item.key} from ${item.field}` }
      next[item.key] = value
    }
  }
  return { kind: 'ok', detail: 'ok', save: next }
}
