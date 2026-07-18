// Generates the app's favicon/PWA icon set — pure JS rasterizer (pngjs only, no
// native image libs) so it runs anywhere without a build toolchain. Draws the same
// mark used in the app header: the TelTech "flame power" logo — a white power-button
// ring whose stem is a gold Shabbat-candle flame, on the brand-azure rounded square.
// Run: node scripts/gen-icons.mjs   (writes into src/web/public/)
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = new URL('../src/web/public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(OUT_DIR, { recursive: true });

const ACCENT = [0x18, 0x77, 0xf2]; // brand azure, matches --color-accent
const WHITE = [0xff, 0xff, 0xff];
const GOLD = [0xe9, 0xa1, 0x3b];   // candle-flame gold, matches the Logo component
const SS = 4; // supersample factor for anti-aliasing

function roundedRectMask(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx, dy = y - cy;
  return (dx * dx + dy * dy) <= r * r || (x >= r && x <= w - r) || (y >= r && y <= h - r);
}

// All glyph geometry is normalized to the Logo component's 64-viewBox, expressed
// here as fractions of the icon size. `scale` shrinks toward the glyph's visual
// center (maskable safe zone).
const GLYPH_CENTER = [0.5, 0.484];
const norm = (px, py, size, scale) => [
  GLYPH_CENTER[0] + (px / size - GLYPH_CENTER[0]) / scale,
  GLYPH_CENTER[1] + (py / size - GLYPH_CENTER[1]) / scale,
];

// Power-button ring: annulus around (32,36) r17 stroke6 with a 70° gap at the
// top, plus round caps at the gap's endpoints.
function ringMask(px, py, size, scale) {
  const [x, y] = norm(px, py, size, scale);
  const cx = 0.5, cy = 36 / 64, rOut = 20 / 64, rIn = 14 / 64, cap = 3 / 64;
  const dx = x - cx, dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d >= rIn && d <= rOut) {
    const fromUp = Math.abs(Math.atan2(dx, -dy)); // 0 = straight up
    if (fromUp > (35 * Math.PI) / 180) return true;
  }
  for (const ex of [22.25 / 64, 41.75 / 64]) {
    const ey = 22.1 / 64;
    if ((x - ex) * (x - ex) + (y - ey) * (y - ey) <= cap * cap) return true;
  }
  return false;
}

// Teardrop: circle at (0.5, yc) radius r, plus a point tapering to (0.5, yTip).
function teardrop(x, y, yTip, yc, r) {
  const dx = x - 0.5, dy = y - yc;
  if (dx * dx + dy * dy <= r * r) return true;
  if (y >= yTip && y < yc) {
    const t = (y - yTip) / (yc - yTip);
    return Math.abs(dx) <= r * Math.pow(t, 1.4);
  }
  return false;
}

const flameMask = (px, py, size, scale) => {
  const [x, y] = norm(px, py, size, scale);
  return teardrop(x, y, 6 / 64, 21 / 64, 8 / 64);
};
const flameHoleMask = (px, py, size, scale) => {
  const [x, y] = norm(px, py, size, scale);
  return teardrop(x, y, 14 / 64, 21 / 64, 4 / 64);
};

function renderIcon(size, { maskable = false } = {}) {
  const png = new PNG({ width: size, height: size });
  const radiusFrac = maskable ? 0 : 0.22; // maskable: full-bleed bg, safe-zone glyph
  const r = radiusFrac * size;
  const glyphScale = maskable ? 0.82 : 1; // shrink toward safe zone on maskable

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0, ringHits = 0, flameHits = 0, holeHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (roundedRectMask(px, py, size, size, r)) bgHits++;
          if (ringMask(px, py, size, glyphScale)) ringHits++;
          if (flameMask(px, py, size, glyphScale)) flameHits++;
          if (flameHoleMask(px, py, size, glyphScale)) holeHits++;
        }
      }
      const total = SS * SS;
      const bgA = bgHits / total;
      // Layer order: azure bg → white ring → gold flame → azure flame core.
      let c = [...ACCENT];
      const blend = (col, a) => { c = c.map((v, i) => v * (1 - a) + col[i] * a); };
      blend(WHITE, ringHits / total);
      blend(GOLD, flameHits / total);
      blend(ACCENT, holeHits / total);
      const idx = (size * y + x) << 2;
      png.data[idx] = c[0];
      png.data[idx + 1] = c[1];
      png.data[idx + 2] = c[2];
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
