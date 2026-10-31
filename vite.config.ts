// Build settings for `cf build` / `cf dev`. Worker settings and bindings live in cloudflare.config.ts.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

const SHA1_HEX = /^[0-9a-f]{40}$/;

function plyPin(): string {
	const pkg = JSON.parse(readFileSync(`${import.meta.dirname}/package.json`, "utf8")) as { dependencies?: { ply?: string } };
	const spec = pkg.dependencies?.ply ?? "";
	const sha = spec.slice(spec.lastIndexOf("#") + 1);
	if (!SHA1_HEX.test(sha)) throw new Error("package.json ply dependency must be pinned to a 40-hex commit");
	return sha;
}

function webSha(): string {
	const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	if (!SHA1_HEX.test(sha)) throw new Error("git rev-parse HEAD did not return a 40-hex sha");
	return sha;
}

// This Worker declares no containers, so no build step needs Docker. The Cloudflare Vite plugin (2.0.0-beta.v.5) still
// runs `docker image ls --filter reference=cloudflare-build/…` after every build (buildAndWriteContainerOutput →
// cleanupPreviousBuildOutputImageTags), with execFileSync and no timeout, even when the container list is empty. A hung
// Docker daemon therefore hangs `cf build`, `cf deploy` and every test that builds the bundle; a missing or failing docker
// is caught and ignored. The plugin has no switch to skip it, but it resolves the binary from WRANGLER_DOCKER_BIN when
// buildApp runs, and cf build/deploy load this file first in that same process. `false` exits 1 at once, so the cleanup is
// skipped. Remove this line if the Worker ever gains a container.
process.env.WRANGLER_DOCKER_BIN = "false";

export default defineConfig({
	define: {
		__PLY_SHA__: JSON.stringify(plyPin()),
		__PLY_WEB_SHA__: JSON.stringify(webSha()),
	},
	plugins: [cloudflare()],
});
