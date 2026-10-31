// Build settings for `cf build` / `cf dev`. Worker settings and bindings live in cloudflare.config.ts.
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// This Worker declares no containers, so no build step needs Docker. The Cloudflare Vite plugin (2.0.0-beta.v.5) still
// runs `docker image ls --filter reference=cloudflare-build/…` after every build (buildAndWriteContainerOutput →
// cleanupPreviousBuildOutputImageTags), with execFileSync and no timeout, even when the container list is empty. A hung
// Docker daemon therefore hangs `cf build`, `cf deploy` and every test that builds the bundle; a missing or failing docker
// is caught and ignored. The plugin has no switch to skip it, but it resolves the binary from WRANGLER_DOCKER_BIN when
// buildApp runs, and cf build/deploy load this file first in that same process. `false` exits 1 at once, so the cleanup is
// skipped. Remove this line if the Worker ever gains a container.
process.env.WRANGLER_DOCKER_BIN = "false";

export default defineConfig({
	plugins: [cloudflare()],
});
