/** cf prints a banner, then JSON. Take the first object or array. */
export function extractJson(text: string): unknown {
  const obj = text.indexOf('{')
  const arr = text.indexOf('[')
  const start = obj < 0 ? arr : arr < 0 ? obj : Math.min(obj, arr)
  if (start < 0) throw new Error('cf returned no JSON')
  return JSON.parse(text.slice(start)) as unknown
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}
