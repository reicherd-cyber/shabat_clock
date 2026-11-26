// Generates the app's favicon/PWA icon set — pure JS rasterizer (pngjs only, no
// native image libs) so it runs anywhere without a build toolchain. Draws the זימנא
// brand mark: a white clock-arc with time-dots spiralling inward, on the brand-teal
// rounded square. Mirrors the inline SVG in the Logo component (src/web/src/ui.jsx).
// Run: node scripts/gen-icons.mjs   (writes into src/web/public/)
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = new URL('../src/web/public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(OUT_DIR, { recursive: true });

const TEAL = [0x2e, 0x4d, 0x56];  // brand teal, matches --color-accent
const WHITE = [0xff, 0xff, 0xff];
const SS = 4; // supersample factor for anti-aliasing

function roundedRectMask(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx, dy = y - cy;
  return (dx * dx + dy * dy) <= r * r || (x >= r && x <= w - r) || (y >= r && y <= h - r);
}

// Glyph geometry normalized to the Logo component's 64-viewBox as fractions of the
// icon size. `scale` shrinks toward the glyph center (maskable safe zone).
const GLYPH_CENTER = [0.5, 0.5];
const norm = (px, py, size, scale) => [
  GLYPH_CENTER[0] + (px / size - GLYPH_CENTER[0]) / scale,
  GLYPH_CENTER[1] + (py / size - GLYPH_CENTER[1]) / scale,
];

// Clock arc: an annulus around center with a gap on the right side (−40°…70°),
// plus round caps at the two open ends — same shape as the SVG mark.
const R_OUT = 0.418, R_IN = 0.332, CAP = 0.043;
const CAPS = [[0.787, 0.259], [0.628, 0.852]]; // ends at θ=−40° and θ=70°, r≈0.375
function arcMask(px, py, size, scale) {
  const [x, y] = norm(px, py, size, scale);
  const dx = x - 0.5, dy = y - 0.5;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d >= R_IN && d <= R_OUT) {
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (!(ang > -40 && ang < 70)) return true;
  }
  for (const [cx, cy] of CAPS) if ((x - cx) ** 2 + (y - cy) ** 2 <= CAP * CAP) return true;
  return false;
}

// Time-dots spiralling inward from the arc's upper end toward the centre.
const DOTS = [
  [0.719, 0.328, 0.041], [0.625, 0.391, 0.034], [0.547, 0.461, 0.028],
  [0.484, 0.539, 0.023], [0.438, 0.625, 0.019], [0.406, 0.703, 0.015],
];
function dotsMask(px, py, size, scale) {
  const [x, y] = norm(px, py, size, scale);
  for (const [cx, cy, r] of DOTS) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  return false;
}

function renderIcon(size, { maskable = false } = {}) {
  const png = new PNG({ width: size, height: size });
  const radiusFrac = maskable ? 0 : 0.22; // maskable: full-bleed bg, safe-zone glyph
  const r = radiusFrac * size;
  const glyphScale = maskable ? 0.82 : 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0, markHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (roundedRectMask(px, py, size, size, r)) bgHits++;
          if (arcMask(px, py, size, glyphScale) || dotsMask(px, py, size, glyphScale)) markHits++;
        }
      }
      const total = SS * SS;
      // teal bg → white mark.
      let c = [...TEAL];
      const a = markHits / total;
      c = c.map((v, i) => v * (1 - a) + WHITE[i] * a);
      const idx = (size * y + x) << 2;
      png.data[idx] = c[0];
      png.data[idx + 1] = c[1];
      png.data[idx + 2] = c[2];
      png.data[idx + 3] = Math.round((bgHits / total) * 255);
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
  writeFileSync(path.join(OUT_DIR, name), PNG.sync.write(renderIcon(size, { maskable })));
  console.log(`wrote ${name} (${size}x${size}${maskable ? ', maskable' : ''})`);
}
console.log(`\nIcons written to ${OUT_DIR}`);
