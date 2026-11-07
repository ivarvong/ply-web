// Build settings for `cf build` / `cf deploy` of ply-fresh. Same Docker note as the root vite.config.ts.
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

process.env.WRANGLER_DOCKER_BIN = "false";

export default defineConfig({ plugins: [cloudflare()] });
