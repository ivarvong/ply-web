// Names shared by the operator Worker config, the CLI, and the ply HTTP 405 text.
// A normal `cf deploy` evaluates cloudflare.config.ts with mode undefined or "production" and uploads ply.
// `cf deploy --mode flag-operator` is the only mode that uploads this Worker.

/** Mode that selects the operator Worker. Every other mode, including production, stays on ply. */
export const FLAG_OPERATOR_MODE = 'flag-operator';

/** Caller Worker. It is not ply. It is the only HTTP path that may call FlagControl. */
export const FLAG_OPERATOR_WORKER = 'ply-flag-operator';

/** Compatibility date for the operator Worker. ply keeps the date it already runs on. */
export const FLAG_OPERATOR_COMPATIBILITY_DATE = '2026-11-01';

export const OPERATOR_CONFIG_PATH = '/config';
export const OPERATOR_ROLLOUT_PATH = '/rollout';
export const OPERATOR_TARGETING_PATH = '/targeting';

export const OPERATOR_SPAN = 'flags.operator';
export const OPERATOR_LOG = 'flags.operator';

/** Secret binding on the operator Worker. ply does not gain this binding. */
export const OPERATOR_TOKEN_BINDING = 'FLAG_OPERATOR_TOKEN';

/** Service binding on the operator Worker. It targets ply's FlagControl export. */
export const OPERATOR_CONTROL_BINDING = 'FLAG_CONTROL';
