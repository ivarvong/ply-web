// The ply Worker: the /v1 git API and the public /view repository viewer, served at ply.ivar.workers.dev.
// `cf build`, `cf dev`, `cf deploy` and `cf workers types` read this file. vite.config.ts holds build settings only.
import { bindings, defineConfig, exports } from "cf/config";

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
			// "off" bypasses the Cache API in front of upstream pack fetches.
			PACK_CACHE: bindings.text("on"),
			// /view rate limits. One SQLite Durable Object class, defined by this Worker.
			VIEWER_RATE: bindings.durableObject({ worker: WORKER_NAME, exportName: VIEWER_RATE_CLASS }),
		},
		exports: durableObjects,
	},
});
