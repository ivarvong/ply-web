const brand = Symbol('Secret')

/**
 * A value that must never be written to a run log, a ledger line, or a debrief.
 * `JSON.stringify` throws. Command argv stores the marker `<redacted>` instead of the value.
 */
export class Secret {
  readonly #value: string

  constructor(value: string) {
    if (value.length === 0) throw new Error('empty secret')
    this.#value = value
  }

  /** For the process that must send the credential. Not for logs. */
  reveal(): string {
    return this.#value
  }

  toJSON(): never {
    throw new Error('Secret cannot be serialized')
  }

  toString(): string {
    return '<redacted>'
  }

  [brand](): 'Secret' {
    return 'Secret'
  }
}

export function isSecret(value: unknown): value is Secret {
  return value instanceof Secret
}
