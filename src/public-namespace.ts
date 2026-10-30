// The one Artifacts namespace this Worker serves publicly, read-only. cloudflare.config.ts binds it (PUBLIC_REPOS) and
// src/public.ts matches URLs under /git/<PUBLIC_NAMESPACE>/. Moving to `public-v1` is this line.
export const PUBLIC_NAMESPACE = 'public-v0';
