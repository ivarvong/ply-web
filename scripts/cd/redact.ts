import { Secret } from './secret.ts'

const MIN_SECRET = 8

/** Any Artifacts token version. A backstop for text that was never wrapped as a Secret. */
export const ARTIFACTS_TOKEN = /art_v\d+_[^\s"'\\]+/g

/** Replace every secret, and the Basic form git would send, with `[redacted]`. Short strings are left alone. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET) continue
    const bare = secret.split('?')[0] ?? secret
    for (const value of [secret, bare]) {
      if (value.length < MIN_SECRET) continue
      out = out.split(value).join('[redacted]')
    }
    const basic = Buffer.from(`x-access-token:${bare}`).toString('base64')
    if (basic.length >= MIN_SECRET) out = out.split(basic).join('[redacted]')
  }
  return out.replace(ARTIFACTS_TOKEN, '[redacted]')
}

/**
 * Every `plaintext` string in a cf JSON value, wrapped as a Secret at the moment it is read.
 * The field name is what cf returns. The token text is not required to start with a prefix.
 */
export function harvestSecrets(value: unknown): Secret[] {
  const out: Secret[] = []
  const visit = (node: unknown, key: string | null): void => {
    if (key === 'plaintext' && typeof node === 'string' && node.length > 0) {
      out.push(new Secret(node))
      return
    }
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, null)
      return
    }
    for (const [child, item] of Object.entries(node)) visit(item, child)
  }
  visit(value, null)
  return out
}
