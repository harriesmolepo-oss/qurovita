// Bundles npm packages into browser-ready files under clients/shared/.
// Run once: node scripts/build-vendor.js
// Output is committed so the demo works fully offline.
import esbuild from "esbuild";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..", "..");   // apps/backend/scripts -> monorepo root
const vendorDir = join(root, "clients", "shared", "vendor");

// qrcode as an IIFE — exposes the global `QRCode` used by patient/index.html
await esbuild.build({
  entryPoints: [join(__dirname, "..", "node_modules", "qrcode", "lib", "browser.js")],
  bundle: true,
  format: "iife",
  globalName: "QRCode",
  platform: "browser",
  outfile: join(root, "clients", "shared", "qrcode.min.js"),
  minify: true,
});

// Noble crypto + cbor-x as ESM modules for crypto.js
const esmBundles = [
  { in: "@noble/curves/p256",   out: "noble-curves-p256.js" },
  { in: "@noble/hashes/hkdf",   out: "noble-hashes-hkdf.js" },
  { in: "@noble/hashes/sha256", out: "noble-hashes-sha256.js" },
  { in: "cbor-x",               out: "cbor-x.js" },
];

for (const b of esmBundles) {
  await esbuild.build({
    entryPoints: [b.in],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: join(vendorDir, b.out),
    minify: false,
  });
}

console.log("✓ vendor bundles written to clients/shared/");
