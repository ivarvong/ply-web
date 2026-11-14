// The credential a /bench request presents: a Bearer token, or the password of HTTP Basic (any user name), which is
// how a browser signs in to a page with no script. src/index.js compares it with PLY_TOKEN in constant time.
export type Presented = { readonly tag: 'secret'; readonly value: string } | { readonly tag: 'none' };

export const BENCH_CHALLENGE = 'Basic realm="ply bench", charset="UTF-8"';

export function presentedSecret(authorization: string | null): Presented {
  if (authorization === null) return { tag: 'none' };
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (bearer !== null) return { tag: 'secret', value: String(bearer[1]) };
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(authorization);
  if (basic === null) return { tag: 'none' };
  let text = '';
  try {
    text = new TextDecoder().decode(Uint8Array.from(atob(String(basic[1])), c => c.charCodeAt(0)));
  } catch {
    return { tag: 'none' };
  }
  const colon = text.indexOf(':');
  return colon < 0 || colon === text.length - 1 ? { tag: 'none' } : { tag: 'secret', value: text.slice(colon + 1) };
}
