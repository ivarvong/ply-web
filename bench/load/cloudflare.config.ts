// ply-load: a fixed-rate load source for ply inside Cloudflare (docs/rate-limit.md "Results"), after ~/code/db's db-load.
// One generator Durable Object per (run, region, shard), placed with a locationHint. Deploy from this directory:
//   env -u CLOUDFLARE_API_TOKEN npx cf deploy
//   env -u CLOUDFLARE_API_TOKEN npx cf workers secrets update PLY_LOAD_TOKEN --worker ply-load --type secret_text
// PLY_LOAD_TOKEN is the load-test credential (ply's x-ply-load-token), never PLY_TOKEN: this Worker holds no /v1 access.
import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
	worker: {
		name: "ply-load",
		compatibilityDate: "2026-10-19",
		entrypoint: "index.ts",
		workersDev: true,
		previewUrls: false,
		observability: { enabled: true, headSamplingRate: 1, logs: { enabled: true, invocationLogs: false }, traces: { enabled: false } },
		env: {
			// The load-test credential: authorises the control API here and is sent as x-ply-load-token to ply. Never logged.
			PLY_LOAD_TOKEN: bindings.secret(),
			GEN: bindings.durableObject({ worker: "ply-load", exportName: "Generator" }),
		},
		exports: {
			Generator: exports.durableObject({ storage: "sqlite" }),
			default: exports.worker({}),
		},
	},
});
