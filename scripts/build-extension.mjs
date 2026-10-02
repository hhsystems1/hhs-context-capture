import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repositoryRoot, "apps/browser-extension");
const output = path.join(source, "dist");
await mkdir(output, { recursive: true });
await Promise.all([
  build({ entryPoints: [path.join(source, "src/background.ts")], outfile: path.join(output, "background.js"), bundle: true, format: "esm", platform: "browser", target: "chrome120", sourcemap: true }),
  build({ entryPoints: [path.join(source, "src/content.ts")], outfile: path.join(output, "content.js"), bundle: true, format: "iife", platform: "browser", target: "chrome120", sourcemap: true }),
  build({ entryPoints: [path.join(source, "src/popup.ts")], outfile: path.join(output, "popup.js"), bundle: true, format: "esm", platform: "browser", target: "chrome120", sourcemap: true }),
]);
await Promise.all(["manifest.json", "popup.html", "popup.css"].map((file) => cp(path.join(source, file), path.join(output, file))));
console.log(`Extension built at ${output}`);
