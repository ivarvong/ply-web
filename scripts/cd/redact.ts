const MIN_SECRET = 8

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
  return out
}

const ARTIFACTS_TOKEN = /art_v1_[^\s"'\\]+/g

/** Pull Artifacts token plaintexts out of a cf JSON value. Mutates `into`. */
export function harvestSecrets(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    const found = value.match(ARTIFACTS_TOKEN)
    if (found) into.push(...found)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) harvestSecrets(item, into)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) harvestSecrets(item, into)
  }
}
