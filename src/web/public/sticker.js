// Unit sticker page (see stickerHtml in src/services/shellyOnboard.js): label size
// controls. A separate file, not inline: a window opened from the admin inherits
// the site's CSP (script-src 'self'), which blocks inline scripts — a same-origin
// file is allowed, and the installer page (file://) loads it over https as well.
(function () {
  var el = function (id) { return document.getElementById(id); };
  var sel = el('sz'), w = el('w'), h = el('h'), pr = el('pr'), rot = el('rot');
  if (!sel || !w || !h || !pr || !rot) return;
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem('stickerSize') || 'null'); } catch (e) {}
  var sz = (saved && saved.w && saved.h) ? saved : { w: 50, h: 30 };
  // Twin of stickerSizeCss() in src/services/shellyOnboard.js — keep in step. The label
  // is laid out W×H; "rot" turns it 90° inside an H×W page, for a driver whose paper
  // form is reported the other way round (a label printer prints the page as given).
  function apply() {
    var W = Math.max(20, Math.min(110, Number(w.value) || 50)), H = Math.max(10, Math.min(200, Number(h.value) || 30));
    var R = !!rot.checked;
    // 12 monospace glyphs ≈ 0.62em each fill the width; the bottom half must also hold two small lines.
    var macMm = Math.min((W - 4) / 7.6, H * 0.21);
    var page = R ? H + 'mm ' + W + 'mm' : W + 'mm ' + H + 'mm';
    el('pg').textContent = '@page{size:' + page + ';margin:0}#rot{width:' + page.replace(' ', ';height:') + '}'
      + '#lab{width:' + W + 'mm;height:' + H + 'mm' + (R ? ';transform:rotate(90deg) translateY(-100%)' : '') + '}'
      + '.mac{font-size:' + macMm.toFixed(2) + 'mm}.sub,.who{font-size:' + (macMm * 0.45).toFixed(2) + 'mm}';
    try { localStorage.setItem('stickerSize', JSON.stringify({ w: W, h: H, rot: R })); } catch (e) {}
  }
  w.value = sz.w; h.value = sz.h; rot.checked = !!sz.rot; rot.onchange = apply;
  var pv = sz.w + 'x' + sz.h; sel.value = pv; if (sel.value !== pv) sel.value = 'custom';
  sel.onchange = function () { var v = sel.value; if (v !== 'custom') { var p = v.split('x'); w.value = p[0]; h.value = p[1]; } apply(); };
  w.oninput = h.oninput = function () { sel.value = 'custom'; apply(); };
  pr.onclick = function () { apply(); window.focus(); window.print(); };
  apply();
})();
