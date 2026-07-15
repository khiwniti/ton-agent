/**
 * Generate minimal PNG icon (180×180) and SVG favicon for the TON Agent.
 *
 * Run: node apps/web/scripts/generate-icons.mjs
 * Writes: apps/web/public/icon.png, apps/web/public/favicon.svg
 */
import { writeFileSync } from "node:fs";
import { createCanvas } from "node:canvas";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

// --- 180×180 PNG icon (required by TON Connect, SVG not supported) ---
const size = 180;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext("2d");

// Dark teal background circle
ctx.beginPath();
ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
ctx.fillStyle = "#0d9488"; // teal-600
ctx.fill();

// Inner lighter circle
ctx.beginPath();
ctx.arc(size / 2, size / 2, size / 2 - 18, 0, Math.PI * 2);
ctx.fillStyle = "#14b8a6"; // teal-500
ctx.fill();

// "T" letter
ctx.fillStyle = "#ffffff";
ctx.font = `bold ${Math.round(size * 0.48)}px system-ui, sans-serif`;
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText("T", size / 2 + 1, size / 2 - 2);

const pngBuf = canvas.toBuffer("image/png");
writeFileSync(path.join(publicDir, "icon.png"), pngBuf);
console.log(`✅ Written icon.png (${pngBuf.length} bytes)`);

// --- SVG favicon ---
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="30" fill="#0d9488"/>
  <circle cx="32" cy="32" r="20" fill="#14b8a6"/>
  <text x="32" y="34" text-anchor="middle" fill="white"
        font-size="28" font-weight="bold" font-family="system-ui,sans-serif">T</text>
</svg>`;
writeFileSync(path.join(publicDir, "favicon.svg"), svg);
console.log(`✅ Written favicon.svg (${svg.length} bytes)`);
