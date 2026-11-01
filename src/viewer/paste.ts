// Turn a pasted locator into an https remote the allowlist can accept or reject.
// This does not widen the host check: validatePublicRepoUrl still runs on the result.
import { atIndex, captureGroup } from '../absent.ts';
import { unwrapOr } from '../option.ts';
import { extractRequestPath, rawPathHasUnsafeSegment } from '../pathguard.ts';

export type PastedRepo = { remote: string; ref: string | null; path: string | null };

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\.git)?$/;

function webPath(remote: string): PastedRepo {
  if (remote.includes('\\') || rawPathHasUnsafeSegment(extractRequestPath(remote))) return { remote, ref: null, path: null };
  let u: URL;
  try { u = new URL(remote); }
  catch { return { remote, ref: null, path: null }; }
  if (u.username || u.password || u.search || u.hash) return { remote, ref: null, path: null };
  const parts = u.pathname.split('/').filter(part => part.length > 0).map(part => {
    try { return decodeURIComponent(part); }
    catch { return part; }
  });
  if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    const owner = unwrapOr(atIndex(parts, 0), '');
    const repo = unwrapOr(atIndex(parts, 1), '');
    const ref = unwrapOr(atIndex(parts, 3), '');
    const path = parts.slice(4).join('/');
    u.pathname = `/${owner}/${repo}`;
    return { remote: u.toString(), ref: ref.length > 0 ? ref : null, path: path.length > 0 ? path : null };
  }
  return { remote: u.toString(), ref: null, path: null };
}

/** https URL, github.com/owner/repo, owner/repo (github), or git@host:path with the ssh user dropped. */
export function interpretRemote(raw: string): PastedRepo {
  const text = raw.trim();
  if (!text) return { remote: text, ref: null, path: null };
  const scp = /^git@([A-Za-z0-9.-]+):([^\\]+)$/.exec(text);
  const scpHost = captureGroup(scp, 1);
  const scpPath = captureGroup(scp, 2);
  if (scpHost.tag === 'some' && scpHost.value && scpPath.tag === 'some' && scpPath.value && !text.includes('://')) {
    return webPath(`https://${scpHost.value}/${scpPath.value.replace(/^\/+/, '')}`);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return webPath(text);
  if (OWNER_REPO.test(text)) return { remote: `https://github.com/${text}`, ref: null, path: null };
  if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/|$)/.test(text)) return webPath(`https://${text}`);
  return { remote: text, ref: null, path: null };
}
