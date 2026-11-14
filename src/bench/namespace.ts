// The one Artifacts namespace the probe workbench writes to: the load-and-probe namespace, never the public one.
// cloudflare.config.ts binds it (PROBE_REPOS).
export const PROBE_NAMESPACE = 'ply-loadgen';
