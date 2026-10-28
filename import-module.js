/* =====================================================================
   Dėdės Baldai · Savikainos skaičiuoklė — BRĖŽINIO IMPORTAS (PDF)
   ---------------------------------------------------------------------
   Reads SolidWorks production drawings (*_GAMYBA.pdf): one cabinet per
   page, with the cut-list table (APRAŠYMAS / ILGIS / PLOTIS / STORIS /
   KIEKIS). Each imported cabinet is priced from its PART LIST with the
   app's own rates (cutting, edging, €/m², hardware prices) and then goes
   through the normal quote ladder (markup, waste, design, margin…).

   Install: add ONE line to index.html, after the main <script> block:
       <script src="import-module.js"></script>
   ===================================================================== */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------
     1. PARSER (pure functions — no DOM, also runs in Node for tests)
     ------------------------------------------------------------------ */
  const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
  const numv = s => { const n = parseFloat(String(s == null ? '' : s).replace(',', '.').replace(/[^\d.\-]/g, '')); return isFinite(n) ? n : 0; };

  const HEAD = { NUMERIS: 'no', NUMER: 'no', 'NR.': 'no', NR: 'no', DB_PART: 'db', APRASYMAS: 'name', ILGIS: 'L', PLOTIS: 'W', STORIS: 'T', KIEKIS: 'Q' };

  // hardware price-list names used by the import (custom ones are registered on import)
  const HW = {
    hinge: 'BLUM LANKSTAI', tipon: 'BLUM TIP-ON', tbox: 'BLUM TANDEMBOX', tandem: 'BLUM TANDEM',
    gola: 'GOLA PROFILIS (€/m)', handle: 'RANKENOS PROFILIS (€/m)', legs: 'KOJOS (€/kompl.)'
  };
  const HW_CAT = { 'BLUM LANKSTAI': 'door', 'BLUM TIP-ON': 'door', 'BLUM TANDEMBOX': 'drawer', 'BLUM TANDEM': 'drawer' };

  /** pdf.js document → [{page, items:[{s,x,y,w,rot}]}]  (y measured from the top) */
  async function extractPages(doc) {
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter(i => i.str && i.str.trim()).map(i => ({
        s: i.str, x: i.transform[4], y: vp.height - i.transform[5], w: i.width,
        rot: Math.abs(i.transform[1]) > 0.01 || Math.abs(i.transform[2]) > 0.01
      }));
      pages.push({ page: p, W: vp.width, H: vp.height, items });
    }
    return pages;
  }

  /** cut-list table on one page → [{name,L,W,T,Q}] or null */
  function parseTable(pg) {
    const it = pg.items.filter(i => !i.rot);
    const hdr = it.find(i => norm(i.s) === 'APRASYMAS');
    if (!hdr) return null;
    const heads = it.filter(i => Math.abs(i.y - hdr.y) < 10 && HEAD[norm(i.s)]).sort((a, b) => a.x - b.x);
    const cols = []; heads.forEach(h => { const k = HEAD[norm(h.s)]; if (!cols.some(c => c.k === k)) cols.push({ k, cx: h.x + h.w / 2, x0: h.x, x1: h.x + h.w }); });
    const xmin = Math.min(...cols.map(c => c.x0)) - 14, xmax = Math.max(...cols.map(c => c.x1)) + 14;
    const body = it.filter(i => i.y > hdr.y + 4 && i.x >= xmin && i.x + i.w / 2 <= xmax && !(norm(i.s) === 'IS' && i.y < hdr.y + 14))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    // group into text lines
    const lines = [];
    for (const i of body) { let r = lines.find(r => Math.abs(r.y - i.y) < 3); if (!r) lines.push(r = { y: i.y, v: {} }); const cx = i.x + i.w / 2; let best = cols[0], bd = 1e9; for (const c of cols) { const d = Math.abs(c.cx - cx); if (d < bd) { bd = d; best = c; } } r.v[best.k] = (r.v[best.k] ? r.v[best.k] + ' ' : '') + i.s.trim(); }
    lines.sort((a, b) => a.y - b.y);
    if (!lines.length) return [];
    // cut off anything far below the table (notes etc.)
    const gaps = []; for (let k = 1; k < lines.length; k++) gaps.push(lines[k].y - lines[k - 1].y);
    const pitch = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 14;
    let end = lines.length; for (let k = 1; k < lines.length; k++) if (lines[k].y - lines[k - 1].y > Math.max(40, pitch * 3.2)) { end = k; break; }
    const L = lines.slice(0, end);
    // A table row = one "anchor" line (has a row number, DB code, thickness or qty). Cells that wrap onto
    // several lines (long names, "1781.0"+"0") are centred vertically in the row, so their extra lines sit
    // symmetrically around the anchor → glue them back per column.
    const isAnchor = l => ['no', 'db', 'T', 'Q'].some(k => l.v[k]);
    const anchors = L.filter(isAnchor), frags = L.filter(l => !isAnchor(l)), used = new Set();
    for (const f of frags) {
      if (used.has(f)) continue;
      let best = null, bd = 1e9;
      for (const a of anchors) {
        const d = Math.abs(a.y - f.y); if (d > Math.max(30, pitch * 1.6)) continue;
        const mirror = frags.find(g => g !== f && !used.has(g) && Math.abs(g.y - (2 * a.y - f.y)) < 2.5);
        if (mirror && d < bd) { bd = d; best = { a, mirror }; }
      }
      if (best) { (best.a.frag = best.a.frag || []).push(f, best.mirror); used.add(f); used.add(best.mirror); }
    }
    frags.filter(f => !used.has(f)).forEach(f => anchors.push(f));
    anchors.sort((a, b) => a.y - b.y);
    return anchors.map(a => {
      const all = [a].concat(a.frag || []).sort((p, q) => p.y - q.y);
      const cell = k => all.map(l => l.v[k] || '').join('');
      const name = cell('name');
      return { name, L: numv(cell('L')), W: numv(cell('W')), T: numv(cell('T')), Q: a.v.Q ? numv(a.v.Q) : 1, raw: a.v };
    }).filter(r => r.name || r.L || r.W);
  }

  /** label/value pairs from the overview page title block */
  function parseInfo(pages) {
    const want = [['FASADINE MEDZIAGA', 'facade'], ['KARKASINE MEDZIAGA', 'carcass'], ['STALVIRSIS', 'top'], ['STALVISIS', 'top'], ['RANKENOS/ATIDARYMO', 'handles']];
    const info = {};
    for (const pg of pages.slice(0, 3)) {
      for (const lab of pg.items) {
        const n = norm(lab.s); const w = want.find(x => n.startsWith(x[0])); if (!w || info[w[1]]) continue;
        const cand = pg.items.filter(i => i !== lab && Math.abs(i.y - lab.y) < 9 && i.x > lab.x + lab.w + 4 && i.x < lab.x + lab.w + 260).sort((a, b) => a.x - b.x);
        const v = cand.map(c => c.s.trim()).filter(s => s && !/^[?]$/.test(s) && !/MEDZIAGA|TIPAS/.test(norm(s))).slice(0, 3).join(' ');
        if (v) info[w[1]] = v;
      }
      if (Object.keys(info).length) break;
    }
    return info;
  }

  function classify(n, T) {
    if (/^PLAUSAS|^HDF/.test(n) || (T > 0 && T <= 6)) return 'hdf';
    if (/^FASADAS|^IMITACIJA|^KAMINO_PRIEKIS/.test(n)) return 'fac';
    if (/^NUGARA/.test(n)) return 'back';
    if (/LENTYNA/.test(n)) return 'shelf';
    if (/^PERTVARA/.test(n)) return 'part';
    if (/^STALCIU/.test(n)) return 'drawer';
    return 'carc';
  }
  function defaultEdges(n, cls) {
    if (cls === 'fac') return [2, 2];
    if (cls === 'hdf' || cls === 'back' || cls === 'drawer') return [0, 0];
    if (cls === 'shelf') return /PAK|LAISVA/.test(n) ? [2, 2] : [1, 0];
    return [1, 0];                                   // carcass parts: front edge along the length
  }
  const sideOf = n => /^KAIRE$|^SONAS K\.?P/.test(n) ? 'L' : /^DESINE$|^SONAS D\.?P/.test(n) ? 'R' : '';

  /** one page's rows → cabinet draft */
  function buildCabinet(rows, pageNo) {
    const parts = [], hw = {}, warn = [];
    let placeholder = false, doors = 0, drawers = 0, oven = null, legs = 0;
    const addHw = (key, n) => { if (n > 0) hw[key] = (hw[key] || 0) + n; };
    const addPart = (name, L, W, T, qty, cls, extra) => { const e = defaultEdges(norm(name), cls); parts.push(Object.assign({ name, L, W, T: T || 18, qty, cls, eL: e[0], eW: e[1], side: sideOf(norm(name)) }, extra || {})); };

    for (const r of rows) {
      const n = norm(r.name), Q = r.Q || 1;
      if (!n || n === 'DEFAULT') continue;
      if (/KONFIRMAT|EKSENTRIK|DIGIUK|^VARZT|SAVISRIEG|^KAISCI/.test(n)) continue;                     // fasteners → app's €/m² line
      if (/ORKAIT/.test(n)) { oven = { L: r.L, W: r.W }; continue; }                                     // appliance placeholder, not cut
      if (n === 'FASADAI' || /^FASADAI\b/.test(n)) { placeholder = true; continue; }
      if (/^KOJOS/.test(n)) { legs += Q; continue; }
      if (/^LANKSTAI/.test(n)) {
        const d = (n.match(/[KD]\.P/g) || []).length || 1, per = parseInt((n.match(/>\s*(\d+)/) || [])[1], 10) || 2;
        addHw(/TIP/.test(n) ? HW.tipon : HW.hinge, d * per * Q); doors += d * Q; continue;
      }
      if (/^T\.?BOX/.test(n)) {
        const m = n.match(/T\.?BOX_?(\d+)\s*MM_?DUGNAS_?(\d+)X(\d+)(?:_?NUGARA_?(\d+)X(\d+))?/);
        addHw(HW.tbox, Q); drawers += Q;
        if (m) { addPart('Stalčiaus dugnas ' + m[2] + '×' + m[3], +m[2], +m[3], 16, Q, 'drawer'); if (m[4]) addPart('Stalčiaus nugara ' + m[4] + '×' + m[5], +m[4], +m[5], 16, Q, 'drawer'); }
        else warn.push('Neatpažintas Tandembox įrašas: ' + r.name);
        continue;
      }
      if (/TANDEM/.test(n)) {                                                                              // inner Tandem drawer (wooden box)
        const rail = numv((n.match(/TANDEM_?(\d+)\s*MM/) || [])[1]) || 500, h = numv((n.match(/AUKSTIS_?([\d.]+)/) || [])[1]) || 120, w = numv((n.match(/PLOTIS_?([\d.]+)/) || [])[1]) || 400;
        addHw(HW.tandem, Q);
        addPart('Vid. stalčiaus šonai', rail - 10, h, 16, 2 * Q, 'drawer', { eL: 1, eW: 0 });
        addPart('Vid. stalčiaus priekis/nugara', w, h, 16, 2 * Q, 'drawer', { eL: 1, eW: 0 });
        addPart('Vid. stalčiaus dugnas', w, rail - 10, 16, Q, 'drawer');
        continue;
      }
      if (/GOLA/.test(n)) { const len = numv((n.match(/(\d+)\s*MM/) || [])[1]) || r.L; addHw(HW.gola, Math.round(len * Q) / 1000); continue; }
      if (/^RANKENA/.test(n)) { addHw(HW.handle, Math.round((r.L || 0) * Q) / 1000); continue; }
      if (r.L > 0 && r.W > 0) { addPart(r.name, r.L, r.W, r.T, Q, classify(n, r.T)); continue; }
      if (/^[A-Z]/.test(n) && !(r.L > 0 && r.W > 0) && !/^\d+X\d+$/.test(n)) { warn.push(`„${r.name}" be matmenų lentelėje — praleista, pridėkite ranka`); continue; }
      if (/^\d+X\d+$/.test(n)) continue;                                                                   // stray wrapped fragment
      warn.push('Neatpažinta eilutė: ' + r.name);
    }
    if (legs) addHw(HW.legs, legs);
    // outer sides (for "visible left/right"): the longest KAIRE* / DESINE* / SONAS K.P|D.P panel
    ['L', 'R'].forEach(sd => {
      const re = sd === 'L' ? /^(KAIRE|SONAS K\.?P)/ : /^(DESINE|SONAS D\.?P)/;
      const c = parts.filter(p => p.cls === 'carc' && re.test(norm(p.name)));
      parts.forEach(p => { if (p.side === sd) p.side = ''; });
      if (c.length) { const ar = p => p.L * p.W; const top = c.reduce((a, b) => ar(b) > ar(a) ? b : a); const maxA = Math.max(...parts.filter(p => p.cls === 'carc').map(ar)); if (ar(top) >= 0.4 * maxA) top.side = sd; }
    });

    // ---- overall size from carcass parts
    const carc = parts.filter(p => p.cls === 'carc' || p.cls === 'part' || p.cls === 'shelf' || p.cls === 'back');
    const t = (() => { const c = {}; carc.forEach(p => c[p.T] = (c[p.T] || 0) + 1); const k = Object.keys(c).sort((a, b) => c[b] - c[a])[0]; return +k || 18; })();
    const sides = parts.filter(p => p.side);
    const sidesAny = sides.length ? sides : parts.filter(p => /^(KAIRE|DESINE|SONAS)/.test(norm(p.name)));
    const hz = parts.filter(p => /^(DUGNAS|STOGAS|SURIS|SURISMAS)/.test(norm(p.name)) && p.L >= 100);
    const shelves = parts.filter(p => p.cls === 'shelf' && p.L >= 100);
    let W = 0, H = 0, D = 0, est = false;
    if (sidesAny.length) {
      H = Math.max(...sidesAny.map(p => p.L)); D = Math.max(...sidesAny.map(p => p.W));
      const lens = hz.concat(shelves).map(p => p.L);
      if (lens.length) {
        const X = hz.length ? Math.max(...hz.map(p => p.L)) : Math.max(...lens);
        const fullWidth = lens.some(l => X - l >= 2 * t - 2 && X - l <= 2 * t + 40);   // bottom 600 + rails 564 → bottom runs under the sides
        W = fullWidth ? X : X + 2 * t;
        const full = nm => hz.some(p => new RegExp('^' + nm).test(norm(p.name)) && p.L >= W - 2);
        if (full('DUGNAS')) H += t; if (full('STOGAS')) H += t;
      } else est = true;
    }
    if (!W) { const big = parts.filter(p => p.cls !== 'drawer'); if (big.length) { W = Math.max(...big.map(p => Math.max(p.L, p.W))); H = H || Math.min(...big.map(p => Math.max(p.L, p.W))); } est = true; }
    const has = re => parts.some(p => re.test(norm(p.name)));
    const dish = has(/INDAPLOV/);
    const type = (H > 1200) ? 'ŪKINĖ' : (legs || has(/^SURIS/) || dish) ? 'PASTATOMOS' : has(/^STOGAS/) ? 'PAKABINAMOS' : D >= 470 ? 'PASTATOMOS' : 'PAKABINAMOS';

    // ---- doors without hinge rows (GEL / MARTA / BRASTO style drawings): estimate doors + hinges
    const ovenNiche = oven ? (Math.min(oven.L || 0, oven.W || 0) > 300 ? Math.max(oven.L, oven.W) : 595) + 5 : 0;
    const hasFronts = placeholder || parts.some(p => p.cls === 'fac' && /^FASADAS/.test(norm(p.name)));
    let hingeEst = false;
    const lowOvenFront = oven && (H - ovenNiche) < 450;
    if (hasFronts && doors === 0 && drawers === 0 && !dish && !lowOvenFront && W > 0 && H > 0) {
      const nd = W > 650 ? 2 : 1, dh = H - ovenNiche, per = dh <= 900 ? 2 : dh <= 1500 ? 3 : dh <= 2000 ? 4 : 5;
      doors = nd; addHw(HW.hinge, nd * per); hingeEst = true;
      warn.push(`Vyrių brėžinyje nėra — įvertinta ${nd} ${nd > 1 ? 'durys' : 'durys'} × ${per} vyriai. Patikrinkite (gal TIP-ON / stalčiai).`);
    }
    // ---- fronts: explicit FASADAS rows win; otherwise estimate from the carcass
    const explicitFronts = parts.some(p => p.cls === 'fac' && /^FASADAS/.test(norm(p.name)));
    const explicitArea = parts.filter(p => p.cls === 'fac' && /^FASADAS/.test(norm(p.name))).reduce((s, p) => s + p.L * p.W * p.qty, 0);
    let frontsEst = false;
    if (placeholder && W > 0 && H > 0 && !(explicitFronts && explicitArea >= 0.8 * (W - 3) * (H - 4))) {
      frontsEst = true;
      const ovenH = ovenNiche;
      const fw = Math.max(60, W - 3), fh = Math.max(60, H - ovenH - 4 - (explicitArea > 0 ? explicitArea / fw : 0));
      const nd = doors, nr = drawers;
      if (nr > 0 && nd === 0) addPart('Fasadas (įvertinta)', Math.round(fh / nr), Math.round(fw), 18, nr, 'fac', { est: true });
      else if (nd > 0 && nr === 0) addPart('Fasadas (įvertinta)', Math.round(fh), Math.round(fw / nd), 18, nd, 'fac', { est: true });
      else if (nd > 0 && nr > 0) { const dh = Math.min(fh - 120, Math.max(120, fh - nr * 180)); addPart('Fasadas – durys (įvertinta)', Math.round(dh), Math.round(fw / nd), 18, nd, 'fac', { est: true }); addPart('Fasadas – stalčiai (įvertinta)', Math.round((fh - dh) / nr), Math.round(fw), 18, nr, 'fac', { est: true }); }
      else addPart('Fasadas (įvertinta)', Math.round(fh), Math.round(fw), 18, 1, 'fac', { est: true });
      warn.unshift('Fasadai įvertinti iš korpuso: ' + Math.round(fw) + '×' + Math.round(fh) + ' mm' + (explicitArea > 0 ? ' (atėmus lentelės FASADAS)' : '') + ' — patikrinkite.');
    }
    if (dish && !parts.some(p => p.cls === 'fac')) warn.push('Indaplovės fasado lentelėje nėra — pridėkite jį kaip detalę (Medžiaga: Fasadas).');
    else if (est) warn.push('Spintelės gabaritai nustatyti apytiksliai.');
    const kind = dish ? 'Indaplovė' : type === 'ŪKINĖ' ? 'Aukšta' : (type === 'PAKABINAMOS' && D >= 470) ? 'Spintelė' : type === 'PASTATOMOS' ? 'Apatinė' : 'Pakabinama';
    const what = drawers && !doors ? `stalčių ${drawers}×` : doors ? (doors > 1 ? `${doors} durys` : 'durys') : '';
    return {
      page: pageNo, name: `Lapas ${pageNo} · ${kind} ${Math.round(W)}${what ? ' · ' + what : ''}${oven ? ' · orkaitė' : ''}`,
      type, W: Math.round(W), H: Math.round(H), D: Math.round(D), t, parts, hw: Object.keys(hw).map(k => ({ key: k, n: Math.round(hw[k] * 1000) / 1000 })),
      doors, drawers, legs, oven: !!oven, frontsEst, hingeEst, warn
    };
  }

  /** all pages → {info, cabinets, skipped} */
  function parseDrawing(pages) {
    const cabinets = [], skipped = [];
    for (const pg of pages) {
      const rows = parseTable(pg);
      if (!rows) { skipped.push(pg.page); continue; }
      if (!rows.length) { skipped.push(pg.page); continue; }
      const c = buildCabinet(rows, pg.page);
      if (!c.parts.length && !c.hw.length) { skipped.push(pg.page); continue; }
      cabinets.push(c);
    }
    return { info: parseInfo(pages), cabinets, skipped };
  }

  /* ------------------------------------------------------------------
     2. PRICING of a part-list cabinet (same rates as calcCabinet)
     ------------------------------------------------------------------ */
  function calcParts(c, S) {
    const nm = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
    const cut = nm(S.rates.cut), edge = nm(S.rates.edge);
    const facP = nm(c.defFacadePrice), carcP = nm(c.carcPrice), hdfP = nm(c.backPrice) || 5;
    const G = {}; ['facade', 'box', 'part', 'drawer', 'shelf', 'back'].forEach(k => G[k] = { m2: 0, cut: 0, band: 0, mat: 0 });
    const perPart = [];
    (c.parts || []).forEach(p => {
      const q = nm(p.qty), L = nm(p.L), W = nm(p.W);
      if (p.cls === 'skip' || q <= 0 || L <= 0 || W <= 0) { perPart.push(0); return; }
      const visFac = (p.side === 'L' && c.visLeft) || (p.side === 'R' && c.visRight);
      const grp = p.cls === 'fac' ? 'facade' : p.cls === 'shelf' ? 'shelf' : p.cls === 'part' ? 'part' : p.cls === 'drawer' ? 'drawer' : (p.cls === 'hdf' || p.cls === 'back') ? 'back' : 'box';
      const price = (p.cls === 'fac' || visFac) ? facP : p.cls === 'hdf' ? hdfP : carcP;
      const a = L * W / 1e6 * q, cl = 2 * (L + W) / 1000 * q, bl = (nm(p.eL) * L + nm(p.eW) * W) / 1000 * q;
      const g = G[grp]; g.m2 += a; g.mat += a * price; g.cut += cl; g.band += bl;
      perPart.push(a * price + cl * cut + bl * edge);
    });
    const hwBreak = {}; let hwCost = 0;
    (c.hw || []).forEach(h => {
      const n = nm(h.n); if (!h.key || n <= 0) return;
      const pr = nm((S.rates.hw || {})[h.key]); const cu = (S.rates.hwCustom || []).find(x => x.name === h.key);
      const cat = HW_CAT[h.key] || (cu && cu.cat) || 'other';
      hwBreak[h.key] = hwBreak[h.key] || { n: 0, cost: 0, cat }; hwBreak[h.key].n = Math.round((hwBreak[h.key].n + n) * 1000) / 1000; hwBreak[h.key].cost += n * pr; hwCost += n * pr;
    });
    const sum = k => Object.values(G).reduce((s, g) => s + g[k], 0);
    const mat = sum('mat'), cutLen = sum('cut'), bandLen = sum('band');
    const net = mat + cutLen * cut, withLam = net + bandLen * edge;
    return {
      G, hwCost, hwBreak, secOut: [], cols: 1, colW: [nm(c.W)], colUsed: [], perPart, partsCab: true,
      facadeM2: G.facade.m2, carcM2: G.box.m2 + G.shelf.m2 + G.part.m2, drawerM2: G.drawer.m2,
      cutLen, bandLen, net, withLam, withHw: withLam + hwCost, valid: true, over: false
    };
  }

  const API = { norm, parseTable, parseInfo, buildCabinet, parseDrawing, extractPages, calcParts, HW };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.DBImport = API;
  if (typeof document === 'undefined' || typeof root.calcCabinet !== 'function') return;   // Node / app not present

  /* ------------------------------------------------------------------
     3. APP HOOKS
     ------------------------------------------------------------------ */
  const L2 = (lt, en) => (LANG === 'lt' ? lt : en);
  const esc = s => root.escapeHtml(s);
  const isParts = c => !!(c && Array.isArray(c.parts));
  const S_ = () => S;
  const CLS = [['fac', 'Fasadas', 'Facade'], ['carc', 'Karkasas', 'Carcass'], ['shelf', 'Lentyna', 'Shelf'], ['part', 'Pertvara', 'Partition'], ['back', 'Nugara 18', 'Back 18'], ['drawer', 'Stalčius', 'Drawer'], ['hdf', 'HDF', 'HDF'], ['skip', '— neskaičiuoti', '— skip']];

  const _calc = root.calcCabinet;
  root.calcCabinet = function (c) { return isParts(c) ? calcParts(c, S_()) : _calc.apply(this, arguments); };
  const _sec = root.sectionsHTML;
  root.sectionsHTML = function (i, c, r) { return isParts(c) ? '' : _sec.apply(this, arguments); };
  const _svg = root.cabinetSVG;
  root.cabinetSVG = function (c, r) { return isParts(c) ? partsSVG(c, r) : _svg.apply(this, arguments); };
  const _desc = root.quoteItemDesc;
  if (_desc) root.quoteItemDesc = function (c) { return isParts(c) ? L2(`${(c.parts || []).length} detalių (iš brėžinio)`, `${(c.parts || []).length} parts (from drawing)`) : _desc.apply(this, arguments); };

  function partsSVG(c, r) {
    const W = +c.W || 600, H = +c.H || 720, sc = Math.min(200 / W, 190 / H), w = W * sc, h = H * sc, x = (230 - w) / 2, y = (215 - h) / 2;
    const fr = (c.parts || []).filter(p => p.cls === 'fac' && p.cls !== 'skip');
    const nF = fr.reduce((s, p) => s + (+p.qty || 0), 0);
    let lines = '';
    if (c.drawers && !c.doors) for (let k = 1; k < c.drawers; k++) lines += `<line x1="${x}" x2="${x + w}" y1="${y + h * k / c.drawers}" y2="${y + h * k / c.drawers}" stroke="currentColor" stroke-opacity=".5"/>`;
    else if (c.doors > 1) for (let k = 1; k < c.doors; k++) lines += `<line y1="${y}" y2="${y + h}" x1="${x + w * k / c.doors}" x2="${x + w * k / c.doors}" stroke="currentColor" stroke-opacity=".5"/>`;
    return `<svg viewBox="0 0 230 250" width="100%" style="max-height:250px;color:var(--ink)"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="var(--bench)" stroke="currentColor" stroke-width="1.5"/>${lines}
      <text x="115" y="${y + h + 16}" text-anchor="middle" font-size="11" fill="var(--ink2)" font-family="var(--mono)">${c.W}×${c.H}×${c.D}</text>
      <text x="115" y="${y + h + 31}" text-anchor="middle" font-size="11" fill="var(--ink2)">${(c.parts || []).length} ${L2('detalių', 'parts')} · ${nF} ${L2('fas.', 'fr.')}</text></svg>`;
  }

  function priceFlags(c, r, med) {
    const f = [];
    if (+c.defFacadePrice > 250) f.push(L2(`Fasado kaina ${c.defFacadePrice} €/m² — ar ne klaida?`, `Facade price ${c.defFacadePrice} €/m² — typo?`));
    if (+c.carcPrice > 150) f.push(L2(`Karkaso kaina ${c.carcPrice} €/m² — ar ne klaida?`, `Carcass price ${c.carcPrice} €/m² — typo?`));
    if (med > 0 && r.withHw > med * 5 && r.withHw > 300) f.push(L2('Kaina >5× didesnė nei kitų spintelių', 'Price >5× the other cabinets'));
    return f;
  }

  const _render = root.renderCabinets;
  root.renderCabinets = function () {
    _render.apply(this, arguments);
    const S = S_(), list = document.getElementById('cabList'); if (!list) return;
    const cards = list.querySelectorAll(':scope > .card.cab');
    const res = S.cabinets.map(c => root.calcCabinet(c));
    const sorted = res.map(r => r.withHw).sort((a, b) => a - b), med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    S.cabinets.forEach((c, i) => {
      const card = cards[i]; if (!card) return;
      const flags = priceFlags(c, res[i], med);
      if (flags.length) { const hp = card.querySelector('#hwp_' + c.id); if (hp) { const b = document.createElement('span'); b.className = 'impflag'; b.title = flags.join('\n'); b.textContent = '⚠ ' + L2('Patikrinkite kainą', 'Check price'); hp.parentNode.insertBefore(b, hp); } }
      if (!isParts(c)) return;
      const main = card.querySelector('.cabgrid > div:first-child'); if (main) main.innerHTML = partsMainHTML(i, c, res[i]);
    });
  };
  const _soft = root.softCab;
  root.softCab = function () {
    _soft.apply(this, arguments);
    S_().cabinets.forEach(c => {
      if (!isParts(c)) return; const r = root.calcCabinet(c);
      (r.perPart || []).forEach((v, j) => { const el = document.getElementById(`ipc_${c.id}_${j}`); if (el) el.textContent = eur(v); });
      const m = document.getElementById('ipm_' + c.id); if (m) m.textContent = sumLine(c, r);
    });
  };
  const sumLine = (c, r) => `${L2('Fasadai', 'Fronts')} ${fx(r.facadeM2, 2)} m² · ${L2('karkasas', 'carcass')} ${fx(r.carcM2, 2)} m² · ${L2('stalčiai', 'drawers')} ${fx(r.drawerM2, 2)} m² · ${L2('pjovimas', 'cutting')} ${fx(r.cutLen, 1)} m · ${L2('briaunos', 'edging')} ${fx(r.bandLen, 1)} m`;

  function partsMainHTML(i, c, r) {
    const S = S_();
    const UC = k => `upCabSoft(${i},'${k}',this.value)`;
    const facF = root.matField(L2('Fasadas', 'Facade'), 'FASADAS', c.defFacadeMat, c.defFacadePrice, `upCab(${i},'defFacadeMat',this.value)`, UC('defFacadePrice'));
    const carcF = root.matField(L2('Karkasas', 'Carcass'), 'KARKASAS', c.carcMat, c.carcPrice, `upCab(${i},'carcMat',this.value)`, UC('carcPrice'));
    const hdfF = root.numField(L2('HDF €/m²', 'HDF €/m²'), fx(+c.backPrice || 5, 2), UC('backPrice'), 'step="0.01"');
    const useF = root.selField(t('fUse'), [['VIRTUVĖ', t('useKitchen')], ['SPINTA', t('useWardrobe')]], c.use, `upCab(${i},'use',this.value)`);
    const warn = (c.impWarn || []).length ? `<div class="note impwarn">${c.impWarn.map(w => '⚠ ' + esc(w)).join('<br>')}</div>` : '';
    const clsOpt = v => CLS.map(([k, lt, en]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${L2(lt, en)}</option>`).join('');
    const rows = (c.parts || []).map((p, j) => `<tr class="${p.cls === 'skip' ? 'off' : ''}${p.est ? ' est' : ''}">
        <td><input class="pn" value="${esc(p.name)}" oninput="DBImport.upPart(${i},${j},'name',this.value,1)"></td>
        <td><select onchange="DBImport.upPart(${i},${j},'cls',this.value)">${clsOpt(p.cls)}</select></td>
        <td><input type="number" value="${p.L}" oninput="DBImport.upPart(${i},${j},'L',this.value)"></td>
        <td><input type="number" value="${p.W}" oninput="DBImport.upPart(${i},${j},'W',this.value)"></td>
        <td><input type="number" value="${p.qty}" oninput="DBImport.upPart(${i},${j},'qty',this.value)"></td>
        <td><select onchange="DBImport.upPart(${i},${j},'eL',this.value)">${[0, 1, 2].map(k => `<option ${+p.eL === k ? 'selected' : ''}>${k}</option>`).join('')}</select></td>
        <td><select onchange="DBImport.upPart(${i},${j},'eW',this.value)">${[0, 1, 2].map(k => `<option ${+p.eW === k ? 'selected' : ''}>${k}</option>`).join('')}</select></td>
        <td class="num mono" id="ipc_${c.id}_${j}">${eur((r.perPart || [])[j] || 0)}</td>
        <td><button class="icon-btn" onclick="DBImport.delPart(${i},${j})">✕</button></td></tr>`).join('');
    const hwKeys = Object.keys(S.rates.hw || {});
    const hwRows = (c.hw || []).map((h, j) => `<tr>
        <td><select onchange="DBImport.upHw(${i},${j},'key',this.value)">${(hwKeys.includes(h.key) ? hwKeys : [h.key].concat(hwKeys)).map(k => `<option ${k === h.key ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></td>
        <td><input type="number" step="any" value="${h.n}" oninput="DBImport.upHw(${i},${j},'n',this.value)"></td>
        <td class="num mono">€ ${eur(+((S.rates.hw || {})[h.key]) || 0)}${/€\/m/.test(h.key) ? '/m' : ''}</td>
        <td><button class="icon-btn" onclick="DBImport.delHw(${i},${j})">✕</button></td></tr>`).join('');
    const openP = OPEN.has('impP_' + c.id) ? 'open' : '';
    return `
      <div class="impsrc">📄 ${esc(c.impFile || L2('Brėžinys', 'Drawing'))} · ${L2('lapas', 'page')} ${c.impPage || '–'} · <b>${c.W}×${c.H}×${c.D}</b> mm</div>
      ${warn}
      <div class="fgrid" style="margin-top:10px">${facF}${carcF}${hdfF}${useF}</div>
      <div class="checks" style="margin-top:8px">
        <label class="ck"><input type="checkbox" ${c.visLeft ? 'checked' : ''} onchange="upCab(${i},'visLeft',this.checked)">${t('fVisL')}</label>
        <label class="ck"><input type="checkbox" ${c.visRight ? 'checked' : ''} onchange="upCab(${i},'visRight',this.checked)">${t('fVisR')}</label>
      </div>
      <div class="muted mono" style="font-size:11px;margin-top:8px" id="ipm_${c.id}">${sumLine(c, r)}</div>
      <details class="more" ${openP} ontoggle="tglOpen('impP_${c.id}',this.open)">
        <summary>${L2('Detalės', 'Parts')} (${(c.parts || []).length}) · ${L2('furnitūra', 'hardware')} (${(c.hw || []).length})</summary>
        <div class="tblwrap"><table class="imptbl"><thead><tr><th>${L2('Detalė', 'Part')}</th><th>${L2('Medžiaga', 'Material')}</th><th class="num">${L2('Ilgis', 'Length')}</th><th class="num">${L2('Plotis', 'Width')}</th><th class="num">${L2('Kiek.', 'Qty')}</th><th class="num" title="${L2('Briaunuotos ilgio kraštinės', 'Banded length edges')}">Br. L</th><th class="num" title="${L2('Briaunuotos pločio kraštinės', 'Banded width edges')}">Br. W</th><th class="num">€</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
        <button class="btn sm" style="margin-top:6px" onclick="DBImport.addPart(${i})">＋ ${L2('Detalė', 'Part')}</button>
        <div class="tblwrap" style="margin-top:12px"><table class="imptbl"><thead><tr><th>${L2('Furnitūra', 'Hardware')}</th><th class="num">${L2('Kiekis', 'Qty')}</th><th class="num">€/vnt</th><th></th></tr></thead><tbody>${hwRows}</tbody></table></div>
        <button class="btn sm" style="margin-top:6px" onclick="DBImport.addHw(${i})">＋ ${L2('Furnitūra', 'Hardware')}</button>
      </details>`;
  }

  // part / hardware editing (soft update keeps focus while typing)
  API.upPart = function (i, j, k, v, isText) { const p = S_().cabinets[i].parts[j]; p[k] = isText || k === 'cls' ? v : num(v); if (k === 'cls') { const e = defaultEdges(norm(p.name), v); p.eL = e[0]; p.eW = e[1]; root.renderCabinets(); root.recalc(); } else root.softCab(); root.saveNow(); };
  API.delPart = function (i, j) { S_().cabinets[i].parts.splice(j, 1); root.renderCabinets(); root.recalc(); root.saveNow(); };
  API.addPart = function (i) { S_().cabinets[i].parts.push({ name: L2('Nauja detalė', 'New part'), L: 600, W: 300, T: 18, qty: 1, cls: 'carc', eL: 1, eW: 0, side: '' }); root.renderCabinets(); root.recalc(); root.saveNow(); };
  API.upHw = function (i, j, k, v) { const h = S_().cabinets[i].hw[j]; h[k] = k === 'key' ? v : num(v); if (k === 'key') root.renderCabinets(); root.softCab(); root.saveNow(); };
  API.delHw = function (i, j) { S_().cabinets[i].hw.splice(j, 1); root.renderCabinets(); root.recalc(); root.saveNow(); };
  API.addHw = function (i) { const c = S_().cabinets[i]; (c.hw = c.hw || []).push({ key: HW.hinge, n: 2 }); root.renderCabinets(); root.recalc(); root.saveNow(); };

  /* ------------------------------------------------------------------
     4. IMPORT WINDOW
     ------------------------------------------------------------------ */
  let PDFJS = null, IMP = null;   // IMP = {file, info, cabinets:[{...draft, on:true}], skipped}
  async function getPdfjs() {
    if (PDFJS) return PDFJS;
    const srcs = ['https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/', 'https://unpkg.com/pdfjs-dist@4.10.38/build/'];
    let err;
    for (const base of srcs) { try { const lib = await import(base + 'pdf.min.mjs'); lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs'; PDFJS = lib; return lib; } catch (e) { err = e; } }
    throw err || new Error('pdf.js');
  }

  function defaults() {
    const S = S_(), last = S.cabinets[S.cabinets.length - 1];
    const cheap = cat => { const m = root.cheapestNet ? root.cheapestNet(cat) : null; return m ? root.netM2(m) : null; };
    return {
      fac: last ? +last.defFacadePrice : (cheap('FASADAS') ?? 29), carc: last ? +last.carcPrice : (cheap('KARKASAS') ?? 8),
      hdf: last ? (+last.backPrice || 5) : 5, use: last ? last.use : root.defUse()
    };
  }

  function ensureModal() {
    if (document.getElementById('dbImpModal')) return;
    const st = document.createElement('style');
    st.textContent = `
      #dbImpModal .box{max-width:1180px}
      #dbImpModal .drop{border:2px dashed var(--line2);border-radius:12px;padding:26px;text-align:center;color:var(--ink2);cursor:pointer;background:var(--bench)}
      #dbImpModal .drop.over{border-color:var(--accent,#3b5bdb);background:#eef2ff}
      #dbImpModal .ibar{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:12px 0}
      #dbImpModal .ibar .f{min-width:120px}
      #dbImpModal table.cabs{table-layout:fixed;width:100%}
      #dbImpModal table.cabs td,#dbImpModal table.cabs th{vertical-align:top;overflow-wrap:anywhere}
      #dbImpModal table.cabs col.c1{width:34px} #dbImpModal table.cabs col.c2{width:52px} #dbImpModal table.cabs col.c4{width:118px}
      #dbImpModal table.cabs col.c5{width:96px} #dbImpModal table.cabs col.c6{width:210px} #dbImpModal table.cabs col.c7{width:100px}
      #dbImpModal table.cabs input[type=text],#dbImpModal table.cabs td>input:not([type]){width:100%;box-sizing:border-box}
      #dbImpModal .src{font-size:12px;color:var(--ink2);margin-bottom:6px}
      #dbImpModal .chip{display:inline-block;font-size:11px;padding:1px 7px;border-radius:9px;background:#fff4e5;color:#9a5b00;margin:1px 4px 1px 0}
      #dbImpModal .chip.ok{background:#e9f7ef;color:#1e7a46}
      #dbImpModal details summary{cursor:pointer;font-size:12px;color:var(--ink2)}
      #dbImpModal .plist{font-size:11px;font-family:var(--mono);color:var(--ink2);line-height:1.5;margin-top:4px}
      .impflag{font-size:11px;color:#b42318;background:#fef3f2;border:1px solid #fecdca;border-radius:8px;padding:2px 8px;margin-right:8px;white-space:nowrap}
      .impsrc{font-size:12px;color:var(--ink2)}
      .impwarn{margin-top:8px;background:#fff8eb;border-color:#f5d9a8;color:#7a4b00;font-size:12px}
      table.imptbl{font-size:12px} table.imptbl input{width:70px} table.imptbl input.pn{width:190px} table.imptbl select{max-width:130px}
      table.imptbl tr.off td{opacity:.45} table.imptbl tr.est td{background:#fff8eb}`;
    document.head.appendChild(st);
    const m = document.createElement('div'); m.className = 'modal'; m.id = 'dbImpModal';
    m.innerHTML = `<div class="box"><div class="mh"><h2>${L2('Importuoti brėžinį (PDF)', 'Import drawing (PDF)')}</h2><div style="flex:1"></div><button class="icon-btn" onclick="DBImport.close()">✕</button></div><div class="mb" id="dbImpBody"></div></div>`;
    m.addEventListener('click', e => { if (e.target === m) API.close(); });
    document.body.appendChild(m);
  }

  API.open = function () { ensureModal(); IMP = null; drawModal(); document.getElementById('dbImpModal').classList.add('on'); };
  API.close = function () { const m = document.getElementById('dbImpModal'); if (m) m.classList.remove('on'); };

  function drawModal(msg) {
    const b = document.getElementById('dbImpBody'); if (!b) return;
    const d = IMP ? IMP.prices : defaults();
    const pick = `<div class="drop" id="dbImpDrop" onclick="document.getElementById('dbImpFile').click()">
        <div style="font-size:26px">📄</div><div><b>${L2('Įmeskite gamybos brėžinį (PDF)', 'Drop the production drawing (PDF)')}</b> ${L2('arba spauskite pasirinkti', 'or click to choose')}</div>
        <div class="muted" style="font-size:12px;margin-top:4px">${L2('SolidWorks *_GAMYBA.pdf — viena spintelė lape, su detalių lentele', 'SolidWorks *_GAMYBA.pdf — one cabinet per page with the cut-list table')}</div></div>
        <input type="file" id="dbImpFile" accept="application/pdf,.pdf" hidden onchange="DBImport.file(this.files[0]);this.value=''">`;
    if (!IMP) { b.innerHTML = pick + (msg ? `<div class="note" style="margin-top:10px">${msg}</div>` : ''); wireDrop(); return; }
    const S = S_();
    const tmp = c => calcParts(Object.assign({}, c, { defFacadePrice: d.fac, carcPrice: d.carc, backPrice: d.hdf }), S);
    let tot = 0;
    const rows = IMP.cabinets.map((c, k) => {
      const r = tmp(c); if (c.on) tot += r.withHw;
      const hw = c.hw.map(h => `${h.n}× ${esc(h.key.replace(/ \(€.*\)/, ''))}`).join(', ');
      const plist = c.parts.map(p => `${esc(p.name)} ${p.L}×${p.W}${p.qty > 1 ? ' ×' + p.qty : ''} · ${(CLS.find(x => x[0] === p.cls) || [])[1]}`).join('<br>');
      return `<tr>
        <td><input type="checkbox" ${c.on ? 'checked' : ''} onchange="DBImport.tog(${k},this.checked)"></td>
        <td class="mono">${c.page}</td>
        <td><input value="${esc(c.name)}" oninput="DBImport.ren(${k},this.value)">
            <details><summary>${c.parts.length} ${L2('detalių', 'parts')}</summary><div class="plist">${plist}</div></details>
            ${c.warn.map(w => `<div class="chip">${esc(w)}</div>`).join('')}</td>
        <td class="mono" style="white-space:nowrap">${c.W}×${c.H}×${c.D}</td>
        <td>${c.frontsEst ? `<span class="chip">${L2('įvertinti', 'estimated')}</span>` : c.parts.some(p => p.cls === 'fac') ? `<span class="chip ok">${L2('iš brėžinio', 'from drawing')}</span>` : '–'}<div class="mono" style="font-size:11px">${fx(r.facadeM2, 2)} m²</div></td>
        <td style="font-size:12px">${hw || '–'}</td>
        <td class="num mono">€ ${eur(r.withHw)}</td></tr>`;
    }).join('');
    const info = IMP.info, infoTxt = [['facade', L2('Fasadas', 'Facade')], ['carcass', L2('Karkasas', 'Carcass')], ['top', L2('Stalviršis', 'Worktop')], ['handles', L2('Rankenos', 'Handles')]].filter(([k]) => info[k]).map(([k, l]) => `${l}: <b>${esc(info[k])}</b>`).join(' · ');
    const unpriced = [...new Set(IMP.cabinets.filter(c => c.on).flatMap(c => c.hw.map(h => h.key)))].filter(k => !(+((S.rates.hw || {})[k]) > 0));
    const nEst = IMP.cabinets.filter(c => c.on && c.frontsEst).length;
    b.innerHTML = `
      <div class="src">📄 <b>${esc(IMP.file)}</b> · ${IMP.cabinets.length} ${L2('spintelių', 'cabinets')}${IMP.skipped.length ? ` · ${L2('lapai be detalių lentelės', 'pages without a cut list')}: ${IMP.skipped.join(', ')}` : ''}${infoTxt ? '<br>' + infoTxt : ''}</div>
      <div class="ibar">
        ${root.numField(L2('Fasadas €/m²', 'Facade €/m²'), d.fac, 'DBImport.price(\'fac\',this.value)', 'step="0.5"')}
        ${root.numField(L2('Karkasas €/m²', 'Carcass €/m²'), d.carc, 'DBImport.price(\'carc\',this.value)', 'step="0.5"')}
        ${root.numField('HDF €/m²', d.hdf, 'DBImport.price(\'hdf\',this.value)', 'step="0.5"')}
        ${root.selField(t('fUse'), [['VIRTUVĖ', t('useKitchen')], ['SPINTA', t('useWardrobe')]], d.use, 'DBImport.price(\'use\',this.value)')}
        <div style="flex:1"></div>
        <button class="btn sm" onclick="DBImport.reset()">${L2('Kitas failas', 'Another file')}</button>
      </div>
      ${nEst ? `<div class="note impwarn" style="margin-bottom:8px">⚠ ${L2(`${nEst} spintelių brėžiniuose fasadų matmenų nėra (tik „FASADAI") — jie įvertinti iš korpuso. Tikslumui paprašykite konstruktoriaus įtraukti fasadus su matmenimis į SolidWorks lentelę.`, `${nEst} cabinets have no front sizes in the drawing (only "FASADAI") — estimated from the carcass.`)}</div>` : ''}
      ${unpriced.length ? `<div class="note impwarn" style="margin-bottom:8px">⚠ ${L2('Furnitūra be kainos (nustatykite „Operaciniai kaštai" → Furnitūra)', 'Hardware without a price (set it in Operational costs → Hardware)')}: <b>${unpriced.map(esc).join(', ')}</b></div>` : ''}
      <div class="tblwrap"><table class="cabs"><colgroup><col class="c1"><col class="c2"><col><col class="c4"><col class="c5"><col class="c6"><col class="c7"></colgroup><thead><tr><th></th><th>${L2('Lapas', 'Page')}</th><th>${L2('Spintelė', 'Cabinet')}</th><th>W×H×D</th><th>${L2('Fasadai', 'Fronts')}</th><th>${L2('Furnitūra', 'Hardware')}</th><th class="num">${L2('Savikaina', 'Cost')}</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td colspan="6" style="text-align:right"><b>${L2('Pažymėtų spintelių savikaina (be priedų ir antkainių)', 'Selected cabinets cost (before overheads and margin)')}</b></td><td class="num mono"><b>€ ${eur(tot)}</b></td></tr></tfoot></table></div>
      <div class="ibar" style="justify-content:flex-end">
        <label class="ck"><input type="checkbox" id="dbImpReplace"> ${L2('Pakeisti esamas spinteles', 'Replace existing cabinets')}</label>
        <button class="btn primary" onclick="DBImport.commit()">＋ ${L2('Pridėti', 'Add')} ${IMP.cabinets.filter(c => c.on).length} ${L2('spinteles', 'cabinets')}</button>
      </div>`;
  }
  function wireDrop() {
    const z = document.getElementById('dbImpDrop'); if (!z) return;
    ['dragenter', 'dragover'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => z.addEventListener(ev, e => { e.preventDefault(); z.classList.remove('over'); }));
    z.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) API.file(f); });
  }

  API.file = async function (f) {
    if (!f) return;
    const b = document.getElementById('dbImpBody'); if (b) b.innerHTML = `<div class="note">⏳ ${L2('Skaitomas brėžinys…', 'Reading drawing…')} ${esc(f.name)}</div>`;
    try {
      const lib = await getPdfjs();
      const doc = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
      const res = parseDrawing(await extractPages(doc));
      if (!res.cabinets.length) { IMP = null; drawModal(L2('Šiame PDF nerasta detalių lentelių (stulpelis „APRAŠYMAS"). Ar tai gamybos brėžinys iš SolidWorks?', 'No cut-list tables found in this PDF.')); return; }
      res.cabinets.forEach(c => c.on = true);
      IMP = Object.assign(res, { file: f.name, prices: defaults() });
      drawModal();
    } catch (e) { console.error(e); IMP = null; drawModal(L2('Nepavyko perskaityti PDF: ', 'Could not read PDF: ') + esc(e.message || e)); }
  };
  API.parsed = function (fileName, res) { ensureModal(); res.cabinets.forEach(c => c.on = true); IMP = Object.assign(res, { file: fileName, prices: defaults() }); drawModal(); document.getElementById('dbImpModal').classList.add('on'); };
  API.reset = function () { IMP = null; drawModal(); };
  API.tog = function (k, v) { IMP.cabinets[k].on = v; drawModal(); };
  API.ren = function (k, v) { IMP.cabinets[k].name = v; };
  API.price = function (k, v) { IMP.prices[k] = k === 'use' ? v : num(v); clearTimeout(API._pt); API._pt = setTimeout(drawModal, 350); };

  API.commit = function () {
    const S = S_(); if (!IMP) return;
    const d = IMP.prices, sel = IMP.cabinets.filter(c => c.on);
    if (!sel.length) { root.toast(L2('Nepažymėta nė viena spintelė', 'No cabinets selected')); return; }
    const used = new Set(sel.flatMap(c => c.hw.map(h => h.key)));
    S.rates.hwCustom = S.rates.hwCustom || [];
    [HW.gola, HW.handle, HW.legs].forEach(k => { if (used.has(k) && !S.rates.hwCustom.some(h => h.name === k)) { S.rates.hwCustom.push({ name: k, cat: 'other' }); if (S.rates.hw[k] === undefined) S.rates.hw[k] = 0; } });
    const replace = document.getElementById('dbImpReplace') && document.getElementById('dbImpReplace').checked;
    if (replace) S.cabinets = [];
    sel.forEach(c => {
      const cab = newCabinet();
      Object.assign(cab, {
        name: c.name, W: c.W, D: c.D, H: c.H, type: c.type, use: d.use, thick: c.t, cols: 1, colW: [], sections: [],
        carcMat: '', carcPrice: d.carc, defFacadeMat: '', defFacadePrice: d.fac, hasBack: false, backType: 'hdf', backPrice: d.hdf,
        parts: c.parts.map(p => Object.assign({}, p)), hw: c.hw.map(h => ({ key: h.key, n: h.n })),
        doors: c.doors, drawers: c.drawers, oven: c.oven, legs: c.legs, impFile: IMP.file, impPage: c.page, impWarn: c.warn.slice(),
        impFacName: (IMP.info && IMP.info.facade) || '', impCarcName: (IMP.info && IMP.info.carcass) || ''
      });
      S.cabinets.push(cab);
    });
    if (!S.projectName && IMP.file) { S.projectName = IMP.file.replace(/(_GAMYBA)?\.pdf$/i, ''); const pn = document.getElementById('projName'); if (pn) pn.value = S.projectName; }
    API.close();
    if (root.renderRates) root.renderRates();
    root.renderCabinets(); root.recalc(); root.saveNow();
    root.toast(L2(`Importuota ${sel.length} spintelių`, `Imported ${sel.length} cabinets`));
  };

  // button in the Cabinets card header + empty state
  function addButtons() {
    const head = document.querySelector('#p-cabinets .card > .head');
    if (head && !document.getElementById('dbImpBtn')) {
      const b = document.createElement('button'); b.className = 'btn sm'; b.id = 'dbImpBtn'; b.onclick = API.open;
      b.innerHTML = '📄 ' + L2('Iš brėžinio (PDF)', 'From drawing (PDF)');
      const anchor = head.querySelector('.hspace'); head.insertBefore(b, anchor ? anchor.nextSibling : head.firstChild);
    }
    const eq = document.querySelector('#cabEmpty .eqb');
    if (eq && !document.getElementById('dbImpBtn2')) { const b = document.createElement('button'); b.className = 'btn sm'; b.id = 'dbImpBtn2'; b.onclick = API.open; b.innerHTML = '📄 ' + L2('Iš brėžinio (PDF)', 'From drawing (PDF)'); eq.insertBefore(b, eq.firstChild); }
  }
  // drop a PDF anywhere on the Cabinets tab
  document.addEventListener('dragover', e => { if (document.getElementById('p-cabinets')?.classList.contains('on') && [...(e.dataTransfer?.items || [])].some(i => i.type === 'application/pdf')) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (document.getElementById('dbImpModal')?.classList.contains('on')) return;
    const f = e.dataTransfer?.files?.[0]; if (!f || !/\.pdf$/i.test(f.name) || !document.getElementById('p-cabinets')?.classList.contains('on')) return;
    e.preventDefault(); API.open(); API.file(f);
  });

  const _lang = root.setLang;
  if (typeof _lang === 'function') root.setLang = function () { const r = _lang.apply(this, arguments); ['dbImpBtn', 'dbImpBtn2'].forEach(id => { const b = document.getElementById(id); if (b) b.innerHTML = '📄 ' + L2('Iš brėžinio (PDF)', 'From drawing (PDF)'); }); return r; };

  addButtons();
  try { root.renderCabinets(); root.recalc(); } catch (e) { console.error(e); }
})(typeof window !== 'undefined' ? window : globalThis);
