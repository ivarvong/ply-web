// Path checks that run on the raw request string, before URL normalization collapses `.` and `..`.
// `%2e` / `%2f` / `%5c` are rejected as sequences, not only after they decode into a separator.

/** Path and query are split off a raw URL or an already-relative path. No URL parser. */
export function extractRequestPath(raw: string): string {
  let rest = raw.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (scheme) {
    rest = rest.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    rest = slash < 0 ? '/' : rest.slice(slash);
  }
  const hash = rest.indexOf('#');
  if (hash >= 0) rest = rest.slice(0, hash);
  const query = rest.indexOf('?');
  if (query >= 0) rest = rest.slice(0, query);
  return rest;
}

function encodedSeparator(value: string): boolean {
  return /%(?:2e|2f|5c)/i.test(value);
}

/** True when a raw path contains `.`, `..`, a backslash, or an encoded form of those. */
export function rawPathHasUnsafeSegment(path: string): boolean {
  if (path.includes('\\') || encodedSeparator(path)) return true;
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? '';
    const edge = i === 0 || i === segments.length - 1;
    if (segment === '') {
      if (!edge) return true;
      continue;
    }
    if (segment === '.' || segment === '..') return true;
    let current = segment;
    for (let pass = 0; pass < 3; pass++) {
      if (encodedSeparator(current) || current.includes('\\')) return true;
      let decoded: string;
      try { decoded = decodeURIComponent(current); }
      catch { return true; }
      if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) return true;
      if (decoded === current) break;
      current = decoded;
    }
  }
  return false;
}

/**
 * The `path` query value is a git path. Reject encoded separators and dot segments in the raw
 * query, before searchParams decodes them.
 */
export function rawQueryPathUnsafe(raw: string): boolean {
  const qIndex = raw.indexOf('?');
  if (qIndex < 0) return false;
  let query = raw.slice(qIndex + 1);
  const hash = query.indexOf('#');
  if (hash >= 0) query = query.slice(0, hash);
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    if (key !== 'path') continue;
    const value = eq < 0 ? '' : pair.slice(eq + 1);
    // `%2F` is a path separator inside a git path and is what URLSearchParams writes for `/`, so it is allowed here;
    // an encoded dot or backslash is not. The decoded value is then checked segment by segment.
    if (value.includes('\\') || /%(?:2e|5c)/i.test(value)) return true;
    let decoded: string;
    try { decoded = decodeURIComponent(value.replace(/\+/g, '%20')); }
    catch { return true; }
    if (decoded.includes('\\') || decoded.includes('\0')) return true;
    for (const segment of decoded.split('/')) {
      if (segment === '.' || segment === '..') return true;
    }
  }
  return false;
}
