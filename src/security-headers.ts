// Headers on every Worker response. The viewer replaces the CSP with one that allows its stylesheet.
// script-src stays 'none': there is no inline script and no script host.

export const API_CSP = "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const BASE: ReadonlyArray<readonly [string, string]> = [
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
  ['x-frame-options', 'DENY'],
  ['content-security-policy', API_CSP],
];

/** Fill any of the base headers the handler did not already set. */
export function applySecurityHeaders(headers: Headers): void {
  for (const [name, value] of BASE) {
    if (!headers.has(name)) headers.set(name, value);
  }
}
