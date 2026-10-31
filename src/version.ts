// Deploy identity stamped on every response. Vite's `define` (vite.config.ts) replaces the two
// identifiers with the ply pin and this repo's git SHA at build time. Neither value is a secret.
// Unit tests that import this module without that define see `unknown`.

declare const __PLY_SHA__: string;
declare const __PLY_WEB_SHA__: string;

export const VERSION_HEADER = 'x-ply-version';

const SHA1_HEX = /^[0-9a-f]{40}$/;
const UNKNOWN_SHA = 'unknown';

function injectedSha(value: string): string {
  return SHA1_HEX.test(value) ? value : UNKNOWN_SHA;
}

/** The ply commit this Worker was built against, or `unknown` outside a Vite build. */
export const PLY_SHA: string = injectedSha(typeof __PLY_SHA__ === 'string' ? __PLY_SHA__ : '');

/** The ply-web commit this Worker was built from, or `unknown` outside a Vite build. */
export const PLY_WEB_SHA: string = injectedSha(typeof __PLY_WEB_SHA__ === 'string' ? __PLY_WEB_SHA__ : '');

/** `x-ply-version` value: `ply=<sha> ply-web=<sha>`. */
export function plyVersionValue(ply: string = PLY_SHA, web: string = PLY_WEB_SHA): string {
  return `ply=${ply} ply-web=${web}`;
}
