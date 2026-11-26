// One-off brand tool: finds the small round "time-dots" in the זימנא lockup PNG
// (connected components), writes a copy with the dots erased (lockup-nodots.png)
// and prints their centres/radii so the app can draw them as animated SVG circles
// exactly where the designer put them.  Run: node scripts/split-logo-dots.mjs
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = new URL('../src/web/public/brand/', import.meta.url);
const png = PNG.sync.read(readFileSync(new URL('lockup.png', DIR)));
const { width: W, height: H, data } = png;
const on = (i) => data[i * 4 + 3] > 40;

const seen = new Uint8Array(W * H);
const comps = [];
for (let s = 0; s < W * H; s++) {
  if (seen[s] || !on(s)) continue;
  const stack = [s]; seen[s] = 1;
  const px = [];
  let minX = W, maxX = 0, minY = H, maxY = 0, sx = 0, sy = 0;
  while (stack.length) {
    const p = stack.pop(); px.push(p);
    const x = p % W, y = (p / W) | 0;
    sx += x; sy += y;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    for (const q of [p - 1, p + 1, p - W, p + W]) {
      if (q < 0 || q >= W * H || seen[q] || !on(q)) continue;
      if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
      seen[q] = 1; stack.push(q);
    }
  }
  comps.push({ px, n: px.length, minX, maxX, minY, maxY, cx: sx / px.length, cy: sy / px.length });
}

// Dots: small, roughly square bbox, well filled (a disc fills ~78% of its bbox).
const dots = comps.filter((c) => {
  const w = c.maxX - c.minX + 1, h = c.maxY - c.minY + 1;
  return c.n > 60 && w < W * 0.04 && Math.abs(w - h) <= Math.max(3, w * 0.25) && c.n / (w * h) > 0.6;
});
for (const d of dots) for (const p of d.px) data[p * 4 + 3] = 0; // erase
writeFileSync(new URL('lockup-nodots.png', DIR), PNG.sync.write(png));

const p0 = dots[0]?.px[0] ?? 0;
const first = comps.find((c) => !dots.includes(c));
const col = first ? [...data.slice(first.px[0] * 4, first.px[0] * 4 + 3)] : [];
console.log(JSON.stringify({ W, H, color: col, dots: dots.map((d) => ({ cx: +d.cx.toFixed(1), cy: +d.cy.toFixed(1), r: +(Math.sqrt(d.n / Math.PI)).toFixed(1) })) }));
void p0;
