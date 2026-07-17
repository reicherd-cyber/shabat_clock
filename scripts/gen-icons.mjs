// Generates the app's favicon/PWA icon set — pure JS rasterizer (pngjs only, no
// native image libs) so it runs anywhere without a build toolchain. Draws the same
// mark used in the app header: a terracotta rounded square with a white sparkle.
// Run: node scripts/gen-icons.mjs   (writes into src/web/public/)
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = new URL('../src/web/public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(OUT_DIR, { recursive: true });

const ACCENT = [0x18, 0x77, 0xf2]; // brand azure, matches --color-accent
const WHITE = [0xff, 0xff, 0xff];
const SS = 4; // supersample factor for anti-aliasing

// Signed distance-ish point-in-shape tests, evaluated per supersampled pixel then
// box-averaged down — simple, dependency-free anti-aliasing.
function roundedRectMask(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx, dy = y - cy;
  return (dx * dx + dy * dy) <= r * r || (x >= r && x <= w - r) || (y >= r && y <= h - r);
}

// Sign-based point-in-triangle test (barycentric via cross products).
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// Simple house pictogram (matches the 🏠 used elsewhere in the app): triangular
// roof + rectangular body with a cut-out door. Coordinates are fractions of the
// icon size; `scale` shrinks toward the glyph's own center (maskable safe zone).
function houseMask(px, py, size, scale = 1) {
  const cx = 0.5, cy = 0.52; // glyph's visual center, roof apex through door base
  let x = px / size, y = py / size;
  x = cx + (x - cx) / scale;
  y = cy + (y - cy) / scale;

  const inRoof = pointInTriangle(x, y, 0.5, 0.25, 0.22, 0.56, 0.78, 0.56);
  const inBody = x >= 0.30 && x <= 0.70 && y >= 0.54 && y <= 0.79;
  const inDoor = x >= 0.445 && x <= 0.555 && y >= 0.615 && y <= 0.79;
  return (inRoof || inBody) && !inDoor;
}

function renderIcon(size, { maskable = false } = {}) {
  const png = new PNG({ width: size, height: size });
  const radiusFrac = maskable ? 0 : 0.22; // maskable: full-bleed bg, safe-zone glyph
  const r = radiusFrac * size;
  const glyphScale = maskable ? 0.82 : 1; // shrink toward safe zone on maskable

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0, glyphHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (roundedRectMask(px, py, size, size, r)) bgHits++;
          if (houseMask(px, py, size, glyphScale)) glyphHits++;
        }
      }
      const total = SS * SS;
      const bgA = bgHits / total;
      const glyphA = glyphHits / total;
      const idx = (size * y + x) << 2;
      // Composite: background terracotta (with rounded-corner alpha), then white
      // glyph on top (alpha = its own coverage, since it's always inside the bg).
      const rC = ACCENT[0] * (1 - glyphA) + WHITE[0] * glyphA;
      const gC = ACCENT[1] * (1 - glyphA) + WHITE[1] * glyphA;
      const bC = ACCENT[2] * (1 - glyphA) + WHITE[2] * glyphA;
      png.data[idx] = rC;
      png.data[idx + 1] = gC;
      png.data[idx + 2] = bC;
      png.data[idx + 3] = Math.round(bgA * 255);
    }
  }
  return png;
}

const sizes = [
  { name: 'favicon-16.png', size: 16 },
  { name: 'favicon-32.png', size: 32 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'icon-192-maskable.png', size: 192, maskable: true },
  { name: 'icon-512-maskable.png', size: 512, maskable: true },
];

for (const { name, size, maskable } of sizes) {
  const png = renderIcon(size, { maskable });
  const buf = PNG.sync.write(png);
  writeFileSync(path.join(OUT_DIR, name), buf);
  console.log(`wrote ${name} (${size}x${size}${maskable ? ', maskable' : ''})`);
}
console.log(`\nIcons written to ${OUT_DIR}`);
