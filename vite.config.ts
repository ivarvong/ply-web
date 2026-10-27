// Build settings for `cf build` / `cf dev`. Worker settings and bindings live in cloudflare.config.ts.
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
});
