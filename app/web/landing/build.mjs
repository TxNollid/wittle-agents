import { readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
const root = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(root, "..");
const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "fieldglow/fonts"), { recursive: true });
await mkdir(path.join(dist, "brand"), { recursive: true });
await mkdir(path.join(dist, "api"), { recursive: true });
const outputs = ["index.html", "how-it-works.html", "robots.txt", "sitemap.xml", "landing.css", "landing.mjs", "signup-fields.mjs", "fieldglow-butterflies.js", "fieldglow-butterfly-art.js", "api/signup.mjs", "package.json", "package-lock.json", "vercel.json"];
for (const file of outputs) await copyFile(path.join(root, file), path.join(dist, file));
const assets = [
  "fieldglow/brand-mark.svg",
  "fieldglow/fern.svg",
  "fieldglow/daisy.svg",
  "fieldglow/sprig.svg",
  "fieldglow/fonts/instrument-sans.woff2",
  "fieldglow/fonts/instrument-serif.woff2",
  "fieldglow/fonts/instrument-serif-italic.woff2",
  "fieldglow/fonts/InstrumentSans-LICENSE.txt",
  "fieldglow/fonts/InstrumentSerif-LICENSE.txt",
  "brand/MuseoModerno-700.woff2",
  "brand/MuseoModerno-LICENSE.txt",
];
for (const asset of assets) {
  await copyFile(path.join(web, "public", asset), path.join(dist, asset));
  outputs.push(asset);
}
const manifest = [];
for (const file of outputs) {
  const bytes = await readFile(path.join(dist, file));
  manifest.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(path.join(dist, "manifest.json"), JSON.stringify({ kind: "early_access_landing", files: manifest }, null, 2) + "\n");
console.log(JSON.stringify({ directory: dist, files: manifest.length + 1, bytes: manifest.reduce((sum, file) => sum + file.bytes, 0), signup_api: true, product_routes: false }, null, 2));
