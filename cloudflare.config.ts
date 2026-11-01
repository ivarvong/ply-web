// The ply Worker: the /v1 git API and the public /view repository viewer, served at ply.ivar.workers.dev.
// `cf build`, `cf dev`, `cf deploy` and `cf workers types` read this file. vite.config.ts holds build settings only.
import { bindings, defineConfig, exports, triggers } from "cf/config";
import { FLAGS_MAX_AGE_S, FLAGS_SWR_S } from "./src/flags/ttl.ts";
import { PUBLIC_NAMESPACE } from "./src/public-namespace.ts";

const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
// Merge and rebase line merges are CPU-bound. The paid plan's ceiling for one HTTP request is 5 minutes
// (developers.cloudflare.com/workers/platform/limits, checked 2026-10-23).
const PAID_PLAN_HTTP_CPU_CEILING_MINUTES = 5;
const CPU_LIMIT_MS = PAID_PLAN_HTTP_CPU_CEILING_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
// Head sampling is a fraction of requests in [0, 1]. Every request is logged and traced.
const SAMPLE_EVERY_REQUEST = 1;

const WORKER_NAME = "ply";

// Live Durable Object namespaces. This replaces the ordered `migrations` list of the old config format.
// ViewerRateLimit was created by migration tag "v1-viewer-rate" (new_sqlite_classes) as namespace
// 656fdd50f0d6428393eb2d9250ceee67. Declaring it here as a live SQLite class, with no lifecycle tombstones,
// keeps that namespace and its data.
// Never change `storage` on a live class. Retire or rename a class only with a `state` tombstone.
const durableObjects = {
	ViewerRateLimit: exports.durableObject({ storage: "sqlite" }),
} as const;

// Workers Caching (never the Cache API). The default entrypoint is uncached so it always runs (rate limit, logs, scrub,
// traces). It sends public upload-pack exchanges to the cache-enabled GitCache over ctx.exports (src/gitcache.ts).
// crossVersionCache keeps immutable packs across deploys; CACHE_VERSION (src/cache-version.ts) is in every key.
// Named entrypoints omit `cache` or set `enabled: true`. `enabled: false` does not compile:
// the versions API rejects that block on a named entrypoint with error 10375. The default
// entrypoint is the one place the block is accepted. Caching is off when the block is omitted.
export type NamedWorkerOptions = { cache?: { enabled: true } };

export function namedEntrypoint<const T extends NamedWorkerOptions>(options: T): T {
	return options;
}

export const entrypoints = {
	default: exports.worker({ cache: { enabled: false } }),
	GitCache: exports.worker(namedEntrypoint({ cache: { enabled: true } })),
	// Whole responses pinned to a commit oid (src/pinned.ts): /v1 tree/read/commit and viewer raw files.
	Pinned: exports.worker(namedEntrypoint({ cache: { enabled: true } })),
	// The one flag ruleset (src/flags/cache.ts). Caching stays off on the default entrypoint, which always runs.
	FlagsCache: exports.worker(namedEntrypoint({ cache: { enabled: true } })),
	// Caching is off by default. An explicit `enabled: false` on a named entrypoint is rejected by the API with 10375.
	// RPC writes (src/flags/entry.ts): setRollout and setTargeting are not idempotent GETs.
	FlagControl: exports.worker({} satisfies NamedWorkerOptions),
} as const;

// A binding can only name a class declared live above. src/index.js re-exports it from src/viewer/rate.ts.
const VIEWER_RATE_CLASS: keyof typeof durableObjects = "ViewerRateLimit";

export default defineConfig({
	worker: {
		// The Worker already exists on the account. Renaming it here creates a second Worker.
		name: WORKER_NAME,
		// The date the live Worker already runs on. No nodejs_compat: ply is Web APIs only.
		compatibilityDate: "2026-10-19",
		entrypoint: "src/index.js",
		workersDev: true,
		previewUrls: false,
		limits: { cpuMs: CPU_LIMIT_MS },
		cache: { enabled: false, crossVersionCache: true },
		// Every minute: bring the public-v0 mirrors (src/mirror.ts MIRRORS) to their GitHub branch. MIRROR_SYNC="off" stops it.
		triggers: [triggers.scheduled({ schedule: "* * * * *" })],
		observability: {
			enabled: true,
			headSamplingRate: SAMPLE_EVERY_REQUEST,
			// Remote URLs carry the repo name and path in the query string. Keep them out of the platform's request logs.
			redactQueryString: true,
			logs: { enabled: true, invocationLogs: true },
			traces: { enabled: true, headSamplingRate: SAMPLE_EVERY_REQUEST },
		},
		env: {
			// Bearer token for /v1. A Worker secret, never in this file: set it with
			// `cf workers secrets update PLY_TOKEN --worker ply --type secret_text` (cf prompts for the value).
			// cf uploads it as an `inherit` binding with bindings_inherit=strict, so a deploy keeps the stored value
			// and the API refuses an upload when the Worker has no PLY_TOKEN.
			PLY_TOKEN: bindings.secret(),
			// "on" enables the POST/DELETE endpoints. Anything else answers 501.
			WRITES: bindings.text("on"),
			// "off" sends every upstream exchange direct, past GitCache (Workers Caching).
			PACK_CACHE: bindings.text("on"),
			MIRROR_SYNC: bindings.text("on"),
			// /view rate limits. One SQLite Durable Object class, defined by this Worker.
			VIEWER_RATE: bindings.durableObject({ worker: WORKER_NAME, exportName: VIEWER_RATE_CLASS }),
			// The public namespace, served read-only with no token (src/public.ts). The binding is scoped to this one
			// namespace; the Worker calls only get(<repo>).createToken("read", 3600) and list(). No stored secret.
			PUBLIC_REPOS: bindings.artifacts({ namespace: PUBLIC_NAMESPACE }),
			// The running version's id, sent as x-ply-version on every front-door response so a deploy can prove which
			// version answered a request pinned with Cloudflare-Workers-Version-Overrides (`npm run cd`).
			VERSION: bindings.versionMetadata(),
			// R2 is the flag source of truth: one object, flags/config.json, ETag = revision.
			// The bucket is not created here. It must already exist before a deploy that uploads this binding.
			// `cf deploy` can provision a missing R2 bucket; create `ply-flags` first so that path is not taken.
			FLAGS: bindings.r2({ name: "ply-flags" }),
			FLAGS_MAX_AGE_S: bindings.text(String(FLAGS_MAX_AGE_S)),
			FLAGS_SWR_S: bindings.text(String(FLAGS_SWR_S)),
			// Callers (the CD follow-up) use a service binding to FlagControl. This one is that binding,
			// aimed at this Worker, so the RPC methods are the write API. Reads of the ruleset go through
			// ctx.exports.FlagsCache, which is the cached entrypoint.
			FLAG_CONTROL: bindings.worker({ worker: WORKER_NAME, exportName: "FlagControl" }),
		},
		exports: { ...durableObjects, ...entrypoints },
	},
});
