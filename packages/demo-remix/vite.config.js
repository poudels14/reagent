import path from "path";
import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import { reagent } from "@portal/reagent/dev/vite";

export default defineConfig({
  plugins: [
    remix(),
    reagent({
      tools: [path.join("/")],
    }),
  ],
});
