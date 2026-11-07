// ply-fresh: Workers Cache purge probes and /r freshness watches (index.ts). Deploy from this directory:
//   env -u CLOUDFLARE_API_TOKEN npx cf deploy
//   env -u CLOUDFLARE_API_TOKEN npx cf workers secrets update PLY_TOKEN --worker ply-fresh --type secret_text
import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
	worker: {
		name: "ply-fresh",
		compatibilityDate: "2026-10-19",
		entrypoint: "index.ts",
		workersDev: true,
		previewUrls: false,
		cache: { enabled: false, crossVersionCache: true },
		observability: { enabled: true, headSamplingRate: 1, logs: { enabled: true, invocationLogs: false }, traces: { enabled: false } },
		env: {
			PLY_TOKEN: bindings.secret(),
			W: bindings.durableObject({ worker: "ply-fresh", exportName: "Watcher" }),
			VERSION: bindings.versionMetadata(),
		},
		exports: {
			Watcher: exports.durableObject({ storage: "sqlite" }),
			Probe: exports.worker({ cache: { enabled: true } }),
			default: exports.worker({ cache: { enabled: false } }),
		},
	},
});
