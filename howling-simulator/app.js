/* 하울링 시뮬레이터 — GUI (합주실) */
(function () {
  'use strict';
  const A = window.Acoustics;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const STORE_KEY = 'howlsim.v2';
  const SPK_COLOR = '#3b5bdb';
  const INST_COLOR = '#e8590c';
  const MIC_COLOR = '#c2255c';
  const PATCH_COLORS = { panel50: '#2b8a3e', panel100: '#1b5e20', foam25: '#f08c00', curtain: '#862e9c', basstrap: '#495057', carpet: '#a0522d', acoustic: '#2f9e44' };
  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
  const sgn = (v, d = 1) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + fmt(v, d) : '–');
  const fmtHz = (f) => (f >= 1000 ? (f / 1000).toFixed(2).replace(/\.?0+$/, '') + ' kHz' : Math.round(f) + ' Hz');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const normYaw = (y) => { y = ((((y + 180) % 360) + 360) % 360) - 180; return y === -180 ? 180 : y; };
  const r2 = (v) => Math.round(v * 100) / 100;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isRouted = (s) => s.routed !== false;
  const spkColor = (s) => (isRouted(s) ? SPK_COLOR : INST_COLOR);

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  // ------------------------------------------------------------ 상태
  let uid = 1;
  const newId = () => 'o' + uid++;

  function makeSpeaker(name, model, x, y, z, yaw, pitch, volume, extra) {
    const m = A.SPEAKER_MODELS[model] || {};
    return Object.assign({ id: newId(), name, model: A.SPEAKER_MODELS[model] ? model : 'custom', type: m.type || 'box', power: m.power || 200, sens: m.sens || 92, routed: m.routed !== false, x, y, z, yaw, pitch, volume }, extra || {});
  }
  function makeMic(name, model, x, y, z, yaw, pitch) {
    return { id: newId(), name, model: A.MIC_MODELS[model] ? model : 'beta58a', x, y, z, yaw, pitch };
  }
  function makePerson(name, x, y, z, vocal) {
    return { id: newId(), name, x, y, z, vocal: !!vocal };
  }

  function defaultState() {
    return {
      room: {
        L: 6, W: 4.5, H: 2.7,
        surfaces: { A: 'gypsum', B: 'gypsum', C: 'gypsum', D: 'gypsum', floor: 'carpet', ceil: 'acoustictile' },
        patches: [],
      },
      speakers: [
        makeSpeaker('PA 스피커 L', 'pa12', 0.2, 0.6, 2.0, 20, -15, 45),
        makeSpeaker('PA 스피커 R', 'pa12', 0.2, 3.9, 2.0, -20, -15, 45),
        makeSpeaker('HeadRush FRFR', 'frfr112', 3.0, 0.2, 0.35, 90, 15, 40),
        makeSpeaker('Blackstar ID:Core', 'idcore40', 2.8, 4.3, 0.3, -90, 10, 60),
        makeSpeaker('베이스 앰프', 'bass115', 5.8, 3.3, 0.4, 180, 0, 50),
      ],
      mics: [makeMic('보컬 마이크', 'beta58a', 2.0, 2.25, 1.55, 180, 15)],
      people: [
        makePerson('보컬', 0, 0, 1.6, true),
        makePerson('기타1', 3.0, 1.0, 1.5),
        makePerson('기타2', 2.8, 3.5, 1.5),
        makePerson('베이스', 4.8, 3.2, 1.5),
        makePerson('드럼', 5.0, 1.5, 1.2),
        makePerson('멤버6', 4.0, 0.9, 1.5),
      ],
      adv: { lref: 100, reqMargin: 6, micHpf: 100, taper: 'audio' },
      opt: { pa: true, inst: false, mic: true, weight: 0.4 },
      absorb: { budget: 12, add: 2 },
      heat: 'mic',
    };
  }

  function num(o, k, d) { return Number.isFinite(+o[k]) ? +o[k] : d; }

  function sanitize(s) {
    const d = defaultState();
    if (!s || typeof s !== 'object') return d;
    const room = A.normalizeRoom(Object.assign({}, d.room, s.room || {}));
    const out = {
      room: {
        L: num(room, 'L', d.room.L), W: num(room, 'W', d.room.W), H: num(room, 'H', d.room.H),
        surfaces: room.surfaces,
        patches: room.patches.map((p) => ({ id: newId(), surface: p.surface, type: p.type, u: num(p, 'u', 1), v: num(p, 'v', 1), w: num(p, 'w', 1.2), h: num(p, 'h', 1.2) })),
      },
      adv: Object.assign({}, d.adv, s.adv || {}),
      opt: Object.assign({}, d.opt, s.opt || {}),
      absorb: Object.assign({}, d.absorb, s.absorb || {}),
      heat: ['mic', 'spl', 'bleed', 'none'].includes(s.heat) ? s.heat : d.heat,
      speakers: Array.isArray(s.speakers) && s.speakers.length
        ? s.speakers.map((o, i) => Object.assign(makeSpeaker(o.name || '스피커 ' + (i + 1), o.model || 'custom', num(o, 'x', 1), num(o, 'y', 1), num(o, 'z', 1.5), num(o, 'yaw', 0), num(o, 'pitch', 0), num(o, 'volume', 40)), {
          type: A.SPEAKER_TYPES[o.type] ? o.type : 'box', power: num(o, 'power', 200), sens: num(o, 'sens', 92), routed: o.routed !== false,
        }))
        : d.speakers,
      mics: Array.isArray(s.mics) && s.mics.length
        ? s.mics.map((o, i) => makeMic(o.name || '마이크 ' + (i + 1), A.MIC_MODELS[o.model] ? o.model : (A.MIC_MODELS[o.pattern] ? o.pattern : 'beta58a'), num(o, 'x', 1), num(o, 'y', 1), num(o, 'z', 1.55), num(o, 'yaw', 180), num(o, 'pitch', 0)))
        : d.mics,
      people: Array.isArray(s.people)
        ? s.people.map((p, i) => makePerson(p.name || '멤버 ' + (i + 1), num(p, 'x', 1), num(p, 'y', 1), num(p, 'z', 1.5), p.vocal))
        : d.people,
    };
    if (!['audio', 'linear'].includes(out.adv.taper)) out.adv.taper = 'audio';
    return out;
  }

  function load() {
    try { const raw = localStorage.getItem(STORE_KEY); return raw ? sanitize(JSON.parse(raw)) : null; } catch (e) { return null; }
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }, 300);
  }

  let state = load() || defaultState();
  let selected = state.mics[0] ? { kind: 'mic', id: state.mics[0].id } : null;
  let sim = null;
  let heat = null;
  let undoSnapshot = null;
  let busy = false;
  // 흡음재 추천 미리보기: { steps:[{..., batch}], start, end, usedArea, batches:[{budget, used}] }
  // batch 0 = 처음 추천, 1 이상 = "다음으로 좋은 곳에 추가"로 더한 것
  let absorbPlan = null;

  // ------------------------------------------------------------ 계산
  const engineRoom = () => Object.assign({}, state.room, { people: state.people.length });
  let ctxKey = '', ctxFine = null, ctxHeat = null;
  function contexts() {
    const key = JSON.stringify([state.room, state.people.length]);
    if (key !== ctxKey) {
      ctxKey = key;
      ctxFine = A.prepare(engineRoom(), { perOct: 48 });
      ctxHeat = A.prepare(engineRoom(), { perOct: 12 });
    }
    return { fine: ctxFine, heat: ctxHeat };
  }
  const simOpts = () => ({ lref: +state.adv.lref, micHpf: +state.adv.micHpf, reqMargin: +state.adv.reqMargin, taper: state.adv.taper });
  const peoplePts = () => A.resolvePeople(state.people, state.mics);

  function simulate() {
    const { fine } = contexts();
    const o = simOpts();
    const r = A.evaluate(fine, state.speakers, state.mics, o);
    r.contrib = A.pairContributions(fine, state.speakers, state.mics, r.iMax, o).sort((a, b) => b.db - a.db);
    r.peaks = r.hasLoop ? A.peaks(r, 6, 3) : [];
    r.rt = fine.bandT60(400, 1300);
    r.rtLow = fine.bandT60(100, 280);
    r.cov = A.coverage(fine, state.speakers.filter(isRouted), peoplePts(), o);
    r.bleed = A.bleed(fine, state.speakers, state.mics, o);
    sim = r;
  }

  // ------------------------------------------------------------ 업데이트 스케줄링
  let rafPending = false, heatTimer = null, heatStale = true;
  function requestUpdate(opts) {
    const withHeat = !opts || opts.heat !== false;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        simulate();
        renderStatus();
        renderAdvice();
        syncInputs();
        drawAll();
        save();
      });
    }
    heatStale = true;
    if (withHeat) scheduleHeat();
  }
  function scheduleHeat() {
    clearTimeout(heatTimer);
    heatTimer = setTimeout(() => { computeHeat(); drawPlan(); }, 220);
  }

  // ------------------------------------------------------------ 히트맵
  const lerp = (a, b, t) => a + (b - a) * t;
  function ramp(stops, v) {
    if (v <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) {
        const t = (v - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
        const a = stops[i - 1][1], b = stops[i][1];
        return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
      }
    }
    return stops[stops.length - 1][1];
  }
  function loopStops() {
    const req = +state.adv.reqMargin;
    const s = [[-24, [47, 158, 68]], [-req - 4, [148, 216, 120]], [-req, [255, 212, 59]], [-1.5, [250, 140, 40]], [0, [224, 49, 49]], [6, [134, 46, 156]]];
    s.sort((a, b) => a[0] - b[0]);
    return s.filter((x, i) => i === 0 || x[0] > s[i - 1][0]);
  }
  const BLEED_STOPS = [[-30, [47, 158, 68]], [-20, [148, 216, 120]], [-12, [255, 212, 59]], [-6, [250, 140, 40]], [0, [224, 49, 49]], [6, [134, 46, 156]]];
  const SPL_STOPS = [[-15, [37, 52, 148]], [-10, [44, 127, 184]], [-6, [65, 182, 196]], [-3, [161, 218, 180]], [0, [255, 255, 190]]];

  function refMic() {
    if (selected && selected.kind === 'mic') { const m = state.mics.find((x) => x.id === selected.id); if (m) return m; }
    return state.mics[0];
  }

  function computeHeat() {
    heatStale = false;
    const mode = state.heat;
    if (mode === 'none') { heat = null; renderLegend(); return; }
    const { heat: ctxH, fine } = contexts();
    const { L, W } = state.room;
    const routed = state.speakers.filter(isRouted);
    const target = routed.length > 2 ? 34 : 46;
    const cell = Math.max(L, W) / target;
    const nx = Math.max(4, Math.round(L / cell)), ny = Math.max(4, Math.round(W / cell));
    const vals = new Float64Array(nx * ny);
    const o = simOpts();
    let vmax = -Infinity;
    const m0 = refMic();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = ((i + 0.5) / nx) * L, y = ((j + 0.5) / ny) * W;
        let v;
        if (mode === 'mic') v = m0 && routed.length ? A.evaluate(ctxH, routed, [Object.assign({}, m0, { x, y })], o).maxDb : -60;
        else if (mode === 'bleed') { const b = m0 ? A.bleed(fine, state.speakers, [Object.assign({}, m0, { x, y })], o).db : -60; v = Number.isFinite(b) ? b : -60; }
        else v = routed.length ? A.splAt(fine, routed, { x, y, z: 1.5 }, o).spl : 0;
        vals[j * nx + i] = v;
        if (v > vmax) vmax = v;
      }
    }
    const off = document.createElement('canvas');
    off.width = nx; off.height = ny;
    const g = off.getContext('2d');
    const img = g.createImageData(nx, ny);
    const stops = mode === 'mic' ? loopStops() : mode === 'bleed' ? BLEED_STOPS : SPL_STOPS;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = vals[j * nx + i];
        const c = ramp(stops, mode === 'spl' ? v - vmax : v);
        const p = ((ny - 1 - j) * nx + i) * 4;
        img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    heat = { mode, img: off, vmax, mic: m0 && m0.name };
    renderLegend();
  }

  function gradCss(stops) {
    const lo = stops[0][0], hi = stops[stops.length - 1][0];
    return stops.map(([v, c]) => `rgb(${c.map(Math.round).join(',')}) ${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`).join(',');
  }
  function renderLegend() {
    const el = $('#legend');
    if (!heat) { el.innerHTML = ''; return; }
    if (heat.mode === 'mic') {
      const st = loopStops();
      el.innerHTML = `<span>안전 ${st[0][0]} dB</span><span class="bar" style="background:linear-gradient(90deg,${gradCss(st)})"></span><span>${sgn(st[st.length - 1][0], 0)} dB 하울링</span>
        <span>· ${esc(heat.mic || '마이크')}의 높이·방향·지향성으로 각 지점에 마이크를 놓았을 때의 최대 루프 게인</span>`;
    } else if (heat.mode === 'bleed') {
      el.innerHTML = `<span>적음 −30 dB</span><span class="bar" style="background:linear-gradient(90deg,${gradCss(BLEED_STOPS)})"></span><span>많음 +6 dB</span>
        <span>· 각 지점에 ${esc(heat.mic || '마이크')}를 같은 방향으로 놓았을 때 섞여 드는 악기 앰프 소리 (보컬 대비, 1 kHz)</span>`;
    } else {
      el.innerHTML = `<span>−15 dB</span><span class="bar" style="background:linear-gradient(90deg,${gradCss(SPL_STOPS)})"></span><span>최대 ${fmt(heat.vmax, 0)} dB SPL</span>
        <span>· 귀 높이 1.5 m, 2 kHz, 기준 입력으로 노래할 때 PA 보컬 음압</span>`;
    }
  }

  // ------------------------------------------------------------ 캔버스 공통
  function setupCanvas(cv, cssH) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.parentElement.clientWidth;
    cv.style.height = cssH + 'px';
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(cssH * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h: cssH };
  }
  function label(g, text, x, y, color, align, font) {
    g.font = font || '600 12px system-ui, sans-serif';
    g.textAlign = align || 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }
  const isSel = (kind, id) => selected && selected.kind === kind && selected.id === id;
  const spkLabel = (i) => 'S' + (i + 1);
  const micLabel = (i) => 'M' + (i + 1);
  const pitchText = (p) => (Math.abs(p) < 1 ? '' : (p > 0 ? ' ↑' : ' ↓') + Math.round(Math.abs(p)) + '°');

  // 표시할 흡음재: 적용된 것 + 추천 미리보기
  function patchesForDraw() {
    const list = state.room.patches.map((p) => ({ p, preview: false }));
    if (absorbPlan) absorbPlan.steps.forEach((s, i) => list.push({ p: s, preview: true, rank: i + 1 }));
    return list;
  }

  // ------------------------------------------------------------ 평면도
  let planGeom = null;
  const HANDLE_SPK = 44, HANDLE_MIC = 38;

  function drawPlan() {
    const cv = $('#plan');
    const { L, W } = state.room;
    const wrapW = cv.parentElement.clientWidth;
    const pad = 40;
    let s = (wrapW - 2 * pad) / L;
    let h = W * s + 2 * pad;
    const maxH = Math.max(280, Math.min(640, window.innerHeight * 0.72));
    if (h > maxH) { s = (maxH - 2 * pad) / W; h = maxH; }
    const { g, w } = setupCanvas(cv, Math.round(h));
    const ox = (w - L * s) / 2, oy = pad;
    planGeom = { s, ox, oy, L, W };
    const P = (x, y) => [ox + x * s, oy + (W - y) * s];

    g.fillStyle = '#f7f8fb';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.fillRect(ox, oy, L * s, W * s);

    if (heat) {
      g.save();
      g.globalAlpha = heatStale ? 0.3 : 0.55;
      g.imageSmoothingEnabled = true;
      g.drawImage(heat.img, ox, oy, L * s, W * s);
      g.restore();
    }

    // 1 m 격자
    g.strokeStyle = 'rgba(30,40,60,0.07)';
    g.lineWidth = 1;
    for (let x = 1; x < L; x++) { g.beginPath(); g.moveTo(ox + x * s, oy); g.lineTo(ox + x * s, oy + W * s); g.stroke(); }
    for (let y = 1; y < W; y++) { g.beginPath(); g.moveTo(ox, oy + y * s); g.lineTo(ox + L * s, oy + y * s); g.stroke(); }
    g.fillStyle = '#8a92a6';
    g.font = '11px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'top';
    const stepX = s < 22 ? 2 : 1;
    for (let x = 0; x <= L + 1e-6; x += stepX) g.fillText(String(Math.round(x)), ox + x * s, oy + W * s + 16);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let y = 0; y <= W + 1e-6; y += stepX) g.fillText(String(Math.round(y)), ox - 16, oy + (W - y) * s);

    // 바닥·천장 흡음재
    for (const { p, preview, rank } of patchesForDraw()) {
      if (p.surface !== 'floor' && p.surface !== 'ceil') continue;
      const c = A.clipPatch(state.room, p);
      const [x0, y0] = P(c.u0, c.v1), [x1, y1] = P(c.u1, c.v0);
      const col = PATCH_COLORS[p.type] || '#2b8a3e';
      g.save();
      g.globalAlpha = preview ? 0.18 : 0.22;
      g.fillStyle = col;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.globalAlpha = 0.9;
      g.strokeStyle = col;
      g.lineWidth = 1.5;
      g.setLineDash(p.surface === 'ceil' || preview ? [5, 4] : []);
      g.strokeRect(x0, y0, x1 - x0, y1 - y0);
      g.restore();
      label(g, (rank ? rank + '. ' : '') + (p.surface === 'ceil' ? '천장 ' : '바닥 ') + A.MATERIALS[p.type].name.split(' ')[0], (x0 + x1) / 2, (y0 + y1) / 2, col, 'center', '600 11px system-ui, sans-serif');
    }

    g.strokeStyle = '#2f3747';
    g.lineWidth = 2;
    g.strokeRect(ox, oy, L * s, W * s);

    // 벽 흡음재
    const thick = 7;
    for (const { p, preview, rank } of patchesForDraw()) {
      if (!['A', 'B', 'C', 'D'].includes(p.surface)) continue;
      const c = A.clipPatch(state.room, p);
      const col = PATCH_COLORS[p.type] || '#2b8a3e';
      let rx, ry, rw, rh, lx, ly;
      if (p.surface === 'A' || p.surface === 'B') {
        const [, ya] = P(0, c.u1), [, yb] = P(0, c.u0);
        rx = p.surface === 'A' ? ox - thick / 2 : ox + L * s - thick / 2; ry = ya; rw = thick; rh = yb - ya;
        lx = p.surface === 'A' ? ox + 12 : ox + L * s - 12; ly = (ya + yb) / 2;
      } else {
        const [xa] = P(c.u0, 0), [xb] = P(c.u1, 0);
        ry = p.surface === 'C' ? oy + W * s - thick / 2 : oy - thick / 2; rx = xa; rh = thick; rw = xb - xa;
        lx = (xa + xb) / 2; ly = p.surface === 'C' ? oy + W * s - 13 : oy + 13;
      }
      g.save();
      g.fillStyle = col;
      g.globalAlpha = preview ? 0.55 : 0.95;
      g.fillRect(rx, ry, rw, rh);
      if (preview) { g.globalAlpha = 1; g.setLineDash([3, 3]); g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(rx, ry, rw, rh); }
      g.restore();
      if (rank) label(g, String(rank), lx, ly, col, 'center', '700 12px system-ui, sans-serif');
    }

    // 벽 이름
    const wl = (t, x, y) => label(g, t, x, y, '#2f3747', 'center', '700 12px system-ui, sans-serif');
    wl('A벽', ox - 26, oy + (W * s) / 2 - 12);
    wl('B벽', ox + L * s + 26, oy + (W * s) / 2 - 12);
    wl('C벽', ox + (L * s) / 2, oy + W * s + 30);
    wl('D벽', ox + (L * s) / 2, oy - 22);
    g.fillStyle = '#8a92a6'; g.font = '11px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'bottom';
    g.fillText(`${fmt(L)} × ${fmt(W)} × 높이 ${fmt(state.room.H)} m`, ox + L * s, oy - 14);

    // 보컬 스피커→마이크 경로 (하울링 주파수 기여도)
    if (sim && sim.contrib.length) {
      const top = sim.contrib[0].db;
      for (const c of sim.contrib) {
        const sp = state.speakers[c.si], m = state.mics[c.mi];
        if (!sp || !m) continue;
        const t = clamp(1 + (c.db - top) / 15, 0.08, 1);
        const [x0, y0] = P(sp.x, sp.y), [x1, y1] = P(m.x, m.y);
        g.strokeStyle = c.db > -(+state.adv.reqMargin) ? `rgba(224,49,49,${0.25 + 0.6 * t})` : `rgba(90,100,120,${0.15 + 0.35 * t})`;
        g.lineWidth = 1 + 2.5 * t;
        g.setLineDash([6, 5]);
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
      g.setLineDash([]);
    }

    // 스피커 커버리지
    g.save();
    g.beginPath(); g.rect(ox, oy, L * s, W * s); g.clip();
    state.speakers.forEach((sp) => {
      const [cx, cy] = P(sp.x, sp.y);
      const half = A.speakerHalfAngle(sp.type, 2000) * Math.PI / 180;
      const col = isRouted(sp) ? '59,91,219' : '232,89,12';
      g.fillStyle = `rgba(${col},0.08)`;
      g.strokeStyle = `rgba(${col},0.25)`;
      g.lineWidth = 1;
      if (Math.abs(sp.pitch) > 60) {
        const dz = Math.max(0.3, sp.z - 1.4);
        const rad = Math.min(Math.max(L, W), dz * Math.tan(Math.min(half, 1.4))) * s;
        g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill(); g.stroke();
      } else {
        const len = Math.max(1.0, 2.4 * Math.cos(sp.pitch * Math.PI / 180)) * s;
        const yaw = -sp.yaw * Math.PI / 180;
        g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, len, yaw - half, yaw + half); g.closePath();
        g.fill(); g.stroke();
      }
    });
    g.restore();

    // 인원 (보컬 제외)
    const pts = peoplePts();
    state.people.forEach((p) => {
      if (p.vocal) return;
      const [cx, cy] = P(p.x, p.y);
      const r = Math.max(8, 0.2 * s);
      g.fillStyle = isSel('person', p.id) ? '#868e9f' : '#adb5c7';
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
      if (isSel('person', p.id)) { g.strokeStyle = '#ffb703'; g.lineWidth = 3; g.stroke(); }
      label(g, p.name, cx, cy + r + 9, '#4a5163', 'center', '600 11px system-ui, sans-serif');
    });

    // 마이크 극성 패턴 + 보컬
    state.mics.forEach((m, i) => {
      const [cx, cy] = P(m.x, m.y);
      const a = A.micA(A.micPattern(m));
      const R = 30;
      const yaw = -m.yaw * Math.PI / 180;
      g.beginPath();
      for (let k = 0; k <= 96; k++) {
        const phi = (k / 96) * Math.PI * 2;
        const rr = Math.abs(a + (1 - a) * Math.cos(phi)) * R;
        const px = cx + rr * Math.cos(phi + yaw), py = cy + rr * Math.sin(phi + yaw);
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fillStyle = 'rgba(194,37,92,0.10)';
      g.strokeStyle = 'rgba(194,37,92,0.55)';
      g.lineWidth = 1.2;
      g.fill(); g.stroke();
      if (i === 0) {
        const voc = pts.find((p) => p.vocal);
        if (voc) {
          const d = A.dirVec(m.yaw, 0);
          const [tx, ty] = P(m.x + d[0] * 0.3, m.y + d[1] * 0.3);
          const hr = Math.max(7, 0.18 * s);
          g.fillStyle = '#e6a3bd';
          g.beginPath(); g.arc(tx, ty, hr, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#b3406b';
          g.beginPath(); g.arc(tx + Math.cos(yaw + Math.PI) * hr * 0.75, ty + Math.sin(yaw + Math.PI) * hr * 0.75, hr * 0.35, 0, Math.PI * 2); g.fill();
          label(g, voc.name, tx, ty - hr - 9, MIC_COLOR, 'center', '600 11px system-ui, sans-serif');
        }
      }
    });

    // 스피커 본체
    state.speakers.forEach((sp, i) => {
      const [cx, cy] = P(sp.x, sp.y);
      const col = spkColor(sp);
      const yaw = -sp.yaw * Math.PI / 180;
      g.save();
      g.translate(cx, cy);
      if (sp.type === 'ceiling') {
        const r = Math.max(8, 0.22 * s);
        g.fillStyle = col;
        g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#fff'; g.lineWidth = 2;
        g.beginPath(); g.arc(0, 0, r * 0.5, 0, Math.PI * 2); g.stroke();
      } else {
        g.rotate(yaw);
        const dep = Math.max(11, 0.3 * s), wid = Math.max(16, 0.45 * s);
        g.fillStyle = col;
        g.fillRect(-dep / 2, -wid / 2, dep, wid);
        g.fillStyle = 'rgba(255,255,255,0.6)';
        g.fillRect(dep / 2 - 3, -wid / 2, 3, wid);
      }
      if (isSel('spk', sp.id)) {
        g.strokeStyle = '#ffb703'; g.lineWidth = 3;
        g.beginPath(); g.arc(0, 0, Math.max(14, 0.35 * s), 0, Math.PI * 2); g.stroke();
      }
      g.restore();
      if (sp.type !== 'ceiling' && Math.abs(sp.pitch) < 85) {
        const hx = cx + Math.cos(yaw) * HANDLE_SPK, hy = cy + Math.sin(yaw) * HANDLE_SPK;
        g.strokeStyle = col; g.lineWidth = 2;
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(hx, hy); g.stroke();
        g.fillStyle = '#fff'; g.beginPath(); g.arc(hx, hy, 6, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      // 라벨: 위·아래를 향하면 본체 옆에, 좌·우를 향하면 본체 위(위쪽 벽 근처면 아래)에 — 방향 핸들과 겹치지 않게
      const text = spkLabel(i) + pitchText(sp.pitch);
      g.font = '600 12px system-ui, sans-serif';
      const tw = g.measureText(text).width;
      const half = Math.max(16, 0.45 * s) / 2;
      if (Math.abs(Math.sin(yaw)) > 0.7) {
        const right = cx + half + 8 + tw / 2 < ox + L * s - 4;
        label(g, text, right ? cx + half + 8 + tw / 2 : cx - half - 8 - tw / 2, cy, col);
      } else {
        const off = Math.max(20, 0.3 * s) + 4;
        label(g, text, clamp(cx, ox + tw / 2 + 2, ox + L * s - tw / 2 - 2), cy - oy < 34 ? cy + off : cy - off, col);
      }
    });

    // 마이크 본체
    state.mics.forEach((m, i) => {
      const [cx, cy] = P(m.x, m.y);
      const yaw = -m.yaw * Math.PI / 180;
      const hx = cx + Math.cos(yaw) * HANDLE_MIC, hy = cy + Math.sin(yaw) * HANDLE_MIC;
      g.strokeStyle = MIC_COLOR; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(hx, hy); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(hx, hy, 6, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = MIC_COLOR;
      g.beginPath(); g.arc(cx, cy, 7.5, 0, Math.PI * 2); g.fill();
      if (isSel('mic', m.id)) { g.strokeStyle = '#ffb703'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.stroke(); }
      label(g, micLabel(i), cx - Math.cos(yaw) * 18, cy - Math.sin(yaw) * 18 - 4, MIC_COLOR);
    });
  }

  // ------------------------------------------------------------ 측면도 (C벽 쪽에서 본 모습)
  let sideGeom = null;
  function sideHandle(o, len, P) {
    const d = A.dirVec(o.yaw, o.pitch);
    let hx = d[0], hz = d[2];
    const n = Math.hypot(hx, hz);
    if (n < 0.2) { hx = 0; hz = d[2] >= 0 ? 1 : -1; } else { hx /= n; hz /= n; }
    const [cx, cy] = P(o.x, o.z);
    return [cx + hx * len, cy - hz * len];
  }
  // 겹치지 않게 라벨 위치를 위로 밀어 올림
  function placeLabel(placed, x, y, w) {
    let yy = y;
    for (let k = 0; k < 6; k++) {
      if (!placed.some((b) => Math.abs(b.x - x) < (b.w + w) / 2 + 2 && Math.abs(b.y - yy) < 13)) break;
      yy -= 14;
    }
    placed.push({ x, y: yy, w });
    return yy;
  }
  function drawSide() {
    const cv = $('#side');
    const { L, H } = state.room;
    const wrapW = cv.parentElement.clientWidth;
    const pad = 30;
    const h = clamp(H * ((wrapW - 2 * pad) / L) + 2 * pad, 200, 300);
    const s = Math.min((wrapW - 2 * pad) / L, (h - 2 * pad) / H);
    const { g, w } = setupCanvas(cv, Math.round(h));
    const ox = (w - L * s) / 2, oy = (h - H * s) / 2;
    sideGeom = { s, ox, oy, L, H };
    const P = (x, z) => [ox + x * s, oy + (H - z) * s];

    g.fillStyle = '#f7f8fb'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.fillRect(ox, oy, L * s, H * s);
    for (const { p, preview } of patchesForDraw()) {
      const c = A.clipPatch(state.room, p);
      const col = PATCH_COLORS[p.type] || '#2b8a3e';
      g.save();
      g.fillStyle = col;
      if (p.surface === 'C' || p.surface === 'D') {
        const [x0, y0] = P(c.u0, c.v1), [x1, y1] = P(c.u1, c.v0);
        g.globalAlpha = preview ? 0.1 : 0.16;
        g.fillRect(x0, y0, x1 - x0, y1 - y0);
      } else {
        g.globalAlpha = preview ? 0.55 : 0.95;
        if (p.surface === 'A' || p.surface === 'B') {
          const [, y0] = P(0, c.v1), [, y1] = P(0, c.v0);
          g.fillRect(p.surface === 'A' ? ox - 3.5 : ox + L * s - 3.5, y0, 7, y1 - y0);
        } else {
          const [x0] = P(c.u0, 0), [x1] = P(c.u1, 0);
          g.fillRect(x0, p.surface === 'ceil' ? oy - 3.5 : oy + H * s - 3.5, x1 - x0, 7);
        }
      }
      g.restore();
    }
    g.strokeStyle = '#2f3747'; g.lineWidth = 2; g.strokeRect(ox, oy, L * s, H * s);
    g.fillStyle = '#8a92a6'; g.font = '11px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let z = 0; z <= H + 1e-6; z += H > 6 ? 2 : 1) g.fillText(String(z), ox - 6, oy + (H - z) * s);
    label(g, 'A벽', ox, oy + H * s + 14, '#2f3747', 'center', '700 11px system-ui, sans-serif');
    label(g, 'B벽', ox + L * s, oy + H * s + 14, '#2f3747', 'center', '700 11px system-ui, sans-serif');
    g.fillStyle = '#8a92a6'; g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillText('C벽 쪽에서 본 모습', ox + (L * s) / 2, oy + H * s + 8);

    peoplePts().forEach((p) => {
      if (p.vocal) return;
      const [px, py] = P(p.x, p.z);
      const [, fy] = P(p.x, 0);
      g.strokeStyle = 'rgba(134,142,159,0.4)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(px, py); g.lineTo(px, fy); g.stroke();
      g.fillStyle = 'rgba(134,142,159,0.6)';
      g.beginPath(); g.arc(px, py, Math.max(4, 0.12 * s), 0, Math.PI * 2); g.fill();
    });

    const placed = [];
    state.speakers.forEach((sp, i) => {
      const col = spkColor(sp);
      const [cx, cy] = P(sp.x, sp.z);
      const [hx, hy] = sideHandle(sp, 34, P);
      g.strokeStyle = col; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(hx, hy); g.stroke();
      g.save(); g.translate(cx, cy); g.rotate(Math.atan2(hy - cy, hx - cx));
      g.fillStyle = col; g.fillRect(-7, -9, 14, 18);
      g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(4, -9, 3, 18);
      g.restore();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(hx, hy, 5.5, 0, Math.PI * 2); g.fill(); g.stroke();
      if (isSel('spk', sp.id)) { g.strokeStyle = '#ffb703'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 15, 0, Math.PI * 2); g.stroke(); }
      const t = spkLabel(i) + pitchText(sp.pitch);
      g.font = '600 12px system-ui, sans-serif';
      label(g, t, cx, placeLabel(placed, cx, cy - 19, g.measureText(t).width), col);
    });
    state.mics.forEach((m, i) => {
      const [cx, cy] = P(m.x, m.z);
      const [hx, hy] = sideHandle(m, 28, P);
      g.strokeStyle = '#adb5c7'; g.lineWidth = 2;
      const [, fy] = P(m.x, 0);
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, fy); g.stroke();
      g.strokeStyle = MIC_COLOR; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(hx, hy); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(hx, hy, 5.5, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = MIC_COLOR; g.beginPath(); g.arc(cx, cy, 7, 0, Math.PI * 2); g.fill();
      if (isSel('mic', m.id)) { g.strokeStyle = '#ffb703'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.stroke(); }
      label(g, micLabel(i), cx, placeLabel(placed, cx, cy - 18, 22), MIC_COLOR);
    });
  }

  // ------------------------------------------------------------ 주파수 차트
  let chartGeom = null, chartHover = null;
  function drawChart() {
    const cv = $('#chart');
    const { g, w, h } = setupCanvas(cv, 260);
    const padL = 40, padR = 12, padT = 14, padB = 28;
    const fmin = 63, fmax = 8000;
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    if (!sim) return;
    if (!sim.hasLoop) {
      label(g, '보컬 신호를 출력하는 스피커가 없습니다 (하울링 루프 없음)', w / 2, h / 2, '#6b7489', 'center', '13px system-ui, sans-serif');
      chartGeom = null;
      return;
    }
    const req = +state.adv.reqMargin;
    const yMax = Math.max(10, Math.ceil((sim.maxDb + 4) / 5) * 5);
    const yMin = Math.min(-30, yMax - 45);
    const X = (f) => padL + (Math.log(f / fmin) / Math.log(fmax / fmin)) * (w - padL - padR);
    const Y = (d) => padT + ((yMax - d) / (yMax - yMin)) * (h - padT - padB);
    chartGeom = { X, Y, padL, padR, w, h, fmin, fmax };

    g.fillStyle = 'rgba(224,49,49,0.08)'; g.fillRect(padL, Y(yMax), w - padL - padR, Y(0) - Y(yMax));
    g.fillStyle = 'rgba(217,138,11,0.10)'; g.fillRect(padL, Y(0), w - padL - padR, Y(-req) - Y(0));
    g.strokeStyle = '#eef0f5'; g.lineWidth = 1; g.fillStyle = '#8a92a6'; g.font = '11px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const f of [63, 125, 250, 500, 1000, 2000, 4000, 8000]) {
      g.beginPath(); g.moveTo(X(f), padT); g.lineTo(X(f), h - padB); g.stroke();
      g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), X(f), h - padB + 6);
    }
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let d = Math.ceil(yMin / 10) * 10; d <= yMax; d += 10) {
      g.beginPath(); g.moveTo(padL, Y(d)); g.lineTo(w - padR, Y(d)); g.stroke();
      g.fillText(String(d), padL - 6, Y(d));
    }
    g.save(); g.translate(11, (padT + h - padB) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillText('루프 게인 (dB)', 0, 0); g.restore();
    g.strokeStyle = '#e03131'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(padL, Y(0)); g.lineTo(w - padR, Y(0)); g.stroke();
    g.setLineDash([5, 4]); g.strokeStyle = '#d98a0b';
    g.beginPath(); g.moveTo(padL, Y(-req)); g.lineTo(w - padR, Y(-req)); g.stroke();
    g.setLineDash([]);
    g.textAlign = 'right'; g.textBaseline = 'bottom'; g.font = '11px system-ui, sans-serif';
    g.fillStyle = '#e03131'; g.fillText('하울링 0 dB', w - padR - 4, Y(0) - 2);
    g.fillStyle = '#b06f05'; g.fillText(`권장 한계 −${req} dB`, w - padR - 4, Y(-req) - 2);

    const { freqs, db, lateDb } = sim;
    g.save();
    g.beginPath(); g.rect(padL, padT, w - padL - padR, h - padT - padB); g.clip();
    g.strokeStyle = 'rgba(120,130,150,0.7)'; g.lineWidth = 1.2; g.setLineDash([4, 3]);
    g.beginPath();
    for (let i = 0; i < freqs.length; i++) { const x = X(freqs[i]), y = Y(lateDb[i]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke(); g.setLineDash([]);
    g.fillStyle = 'rgba(224,49,49,0.35)';
    g.beginPath(); g.moveTo(X(freqs[0]), Y(0));
    for (let i = 0; i < freqs.length; i++) g.lineTo(X(freqs[i]), Y(Math.max(0, db[i])));
    g.lineTo(X(freqs[freqs.length - 1]), Y(0)); g.closePath(); g.fill();
    g.strokeStyle = '#1d2433'; g.lineWidth = 1.8;
    g.beginPath();
    for (let i = 0; i < freqs.length; i++) { const x = X(freqs[i]), y = Y(db[i]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
    g.restore();

    g.font = '11px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillStyle = '#1d2433'; g.fillText('━ 전체 루프 게인', padL + 6, padT + 2);
    g.fillStyle = '#7c8496'; g.fillText('╌ 잔향 성분', padL + 6, padT + 16);

    const mx = X(sim.fMax), my = Y(sim.maxDb);
    const col = sim.maxDb >= 0 ? '#e03131' : sim.maxDb >= -req ? '#d98a0b' : '#1f9d55';
    g.fillStyle = col; g.beginPath(); g.arc(mx, my, 5, 0, Math.PI * 2); g.fill();
    const txt = `${fmtHz(sim.fMax)}  ${sgn(sim.maxDb)} dB`;
    g.font = '600 12px system-ui, sans-serif';
    const tw = g.measureText(txt).width;
    label(g, txt, clamp(mx - tw / 2, padL + 2, w - padR - tw - 2), Math.max(padT + 8, my - 14), col, 'left');

    if (chartHover != null) {
      const i = chartHover;
      const x = X(freqs[i]);
      g.strokeStyle = 'rgba(29,36,51,0.35)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, h - padB); g.stroke();
      g.fillStyle = '#1d2433'; g.beginPath(); g.arc(x, Y(db[i]), 3.5, 0, Math.PI * 2); g.fill();
      const t = `${fmtHz(freqs[i])}: ${sgn(db[i])} dB (잔향 ${sgn(lateDb[i])})`;
      g.font = '12px system-ui, sans-serif';
      const w2 = g.measureText(t).width + 12;
      const bx = clamp(x + 8, padL, w - padR - w2), by = h - padB - 26;
      g.fillStyle = 'rgba(29,36,51,0.88)'; g.fillRect(bx, by, w2, 20);
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(t, bx + 6, by + 10);
    }
  }

  function drawAll() { drawPlan(); drawSide(); drawChart(); }

  // ------------------------------------------------------------ 상태 표시
  const safeVolume = (v, marginDb, target) => clamp(A.volumeForDelta(v, marginDb - target, state.adv.taper), 0, 100);
  const onsetVolume = (v, marginDb) => A.volumeForDelta(v, marginDb, state.adv.taper);

  function renderStatus() {
    if (!sim) return;
    const req = +state.adv.reqMargin;
    const cls = !sim.hasLoop ? 'safe' : sim.maxDb >= 0 ? 'howl' : sim.maxDb >= -req ? 'risk' : 'safe';
    const b = $('#badge');
    b.className = 'badge ' + cls;
    b.innerHTML = !sim.hasLoop ? '루프 없음<small>보컬 신호 스피커 없음</small>'
      : cls === 'howl' ? '하울링 발생<small>루프 게인이 0 dB를 넘습니다</small>'
        : cls === 'risk' ? `하울링 위험<small>안정 여유 부족 (권장 ≥ ${req} dB)</small>` : '안정<small>하울링 여유 충분</small>';
    const mini = $('#miniStatus');
    mini.className = 'mini-status ' + cls;
    mini.innerHTML = sim.hasLoop ? `<b>${cls === 'howl' ? '하울링 발생' : cls === 'risk' ? '하울링 위험' : '안정'}</b><span>여유 ${fmt(sim.margin)} dB · ${fmtHz(sim.fMax)}</span>` : '<b>하울링 루프 없음</b>';
    $('#mLoop').textContent = sim.hasLoop ? sgn(sim.maxDb) + ' dB' : '–';
    $('#mMargin').textContent = sim.hasLoop ? fmt(sim.margin) + ' dB' : '–';
    $('#mFreq').textContent = sim.hasLoop ? fmtHz(sim.fMax) : '–';
    const pa = state.speakers.filter(isRouted);
    const vols = pa.map((s) => s.volume);
    if (!sim.hasLoop || !pa.length) $('#mOnset').textContent = '–';
    else if (vols.every((v) => v === vols[0])) {
      const on = onsetVolume(vols[0], sim.margin);
      $('#mOnset').textContent = on >= 100 ? '100%에서도 없음' : Math.floor(on) + '%';
    } else $('#mOnset').textContent = '현재 ' + sgn(sim.margin) + ' dB';
    $('#mRt').textContent = fmt(sim.rt, 2) + ' 초';
    $('#mBleed').textContent = Number.isFinite(sim.bleed.db) ? sgn(sim.bleed.db) + ' dB' : '–';
    const V = state.room.L * state.room.W * state.room.H;
    $('#roomInfo').textContent = `체적 ${fmt(V, 0)} m³ · RT60 ≈ ${fmt(sim.rt, 2)}초 (저역 ${fmt(sim.rtLow, 2)}초) · 합주실 권장 0.3–0.45초`;
  }

  function renderAdvice() {
    if (!sim) return;
    const req = +state.adv.reqMargin;
    const items = [];
    const add = (cls, html) => items.push(`<li class="${cls}">${html}</li>`);
    const nm = (i) => `${spkLabel(i)}(${esc(state.speakers[i].name)})`;
    if (!sim.hasLoop) add('info', '보컬(마이크) 신호를 출력하는 스피커가 없어 하울링 루프가 없습니다. PA 스피커의 "보컬 신호 출력"을 확인하세요.');
    else if (sim.maxDb >= 0) add('bad', `<b>${fmtHz(sim.fMax)}</b> 부근에서 하울링이 발생합니다 (루프 게인 <b>${sgn(sim.maxDb)} dB</b>).`);
    else if (sim.maxDb >= -req) add('warn', `하울링 직전입니다. <b>${fmtHz(sim.fMax)}</b> 부근 여유가 <b>${fmt(sim.margin)} dB</b>로 권장값(${req} dB)보다 작아 링잉이 생길 수 있습니다.`);
    else add('good', `안정 여유 <b>${fmt(sim.margin)} dB</b>로 하울링 위험이 낮습니다.`);

    const top = sim.contrib[0];
    if (sim.hasLoop && top && sim.margin < req + 4) {
      const sp = state.speakers[top.si], m = state.mics[top.mi];
      const mn = `${micLabel(top.mi)}(${esc(m.name)})`;
      add('info', `주 원인 경로: <b>${nm(top.si)} → ${mn}</b> · 거리 ${fmt(top.dist)} m`);
      const pattern = A.micPattern(m);
      const nullAng = A.micNullAngle(pattern);
      if (pattern !== 'omni' && top.micAngle < 90) {
        add('bad', `${nm(top.si)}가 ${mn}의 <b>앞쪽 수음 범위</b>(마이크 축에서 ${fmt(top.micAngle, 0)}°)에 있습니다. 마이크 뒤쪽 감도 최저점(약 ${Math.round(nullAng)}°)이 스피커를 향하도록 보컬 방향을 바꾸거나 스피커를 옮기세요.`);
      } else if (nullAng && Math.abs(top.micAngle - nullAng) > 35) {
        const extra = pattern === 'supercardioid' ? ' 슈퍼카디오이드(Beta 58A 등)는 정후면(180°)보다 <b>약 126° 방향</b>이 가장 둔감하므로, PA 2대를 마이크 뒤쪽 양옆(±126°)에 두면 가장 좋습니다.' : '';
        add('warn', `${nm(top.si)}가 ${mn}의 감도 최저점(${Math.round(nullAng)}°)에서 벗어나 있습니다 (현재 ${fmt(top.micAngle, 0)}°).${extra}`);
      }
      const half = A.speakerHalfAngle(sp.type, 2000);
      if (top.spkAngle < half) add('bad', `${nm(top.si)}가 마이크를 <b>직접 향하고</b> 있습니다 (스피커 축에서 ${fmt(top.spkAngle, 0)}°, 커버리지 ±${fmt(half, 0)}°). 좌우 방향이나 상하 각도를 바꿔 마이크를 커버리지 밖에 두세요.`);
      if (top.dist < 2) add('warn', `${nm(top.si)}와 ${mn}의 거리가 ${fmt(top.dist)} m로 가깝습니다. 거리를 2배로 늘리면 직접음 경로가 약 6 dB 줄어듭니다.`);
    }
    const i = sim.iMax;
    if (sim.hasLoop && sim.lateDb[i] > sim.earlyDb[i] && sim.margin < req + 4) {
      add('info', `하울링 주파수에서 <b>잔향음이 지배적</b>입니다(잔향 ${sgn(sim.lateDb[i])} dB vs 직접·초기 반사 ${sgn(sim.earlyDb[i])} dB). 배치보다 흡음재·볼륨 조정이 더 효과적입니다 → 아래 <b>흡음재 추천</b>을 사용해 보세요.`);
    }
    const inst = state.speakers.map((s, k) => ({ s, k })).filter((o) => !isRouted(o.s));
    if (inst.length) {
      add('info', `악기 앰프(${inst.map((o) => spkLabel(o.k)).join(', ')})는 마이크 신호를 내보내지 않으므로 <b>하울링 원인이 아닙니다</b>. 다만 보컬 마이크에 악기 소리가 <b>${sgn(sim.bleed.db)} dB</b>(보컬 대비) 섞입니다.`);
      const tb = sim.bleed.per[0];
      if (tb && tb.db > -12) {
        const g = A.geometry(state.speakers[tb.si], state.mics[tb.mi]);
        add('warn', `${nm(tb.si)} 소리가 마이크로 많이 들어갑니다(${sgn(tb.db)} dB, 마이크 축에서 ${fmt(g.micAngle, 0)}°). 앰프를 마이크 뒤쪽 감도 최저점 방향에 두거나, 앰프를 연주자 쪽으로 기울이고 볼륨을 줄이면 보컬 볼륨을 덜 올려도 되어 하울링에도 유리합니다.`);
      }
    }
    if (state.mics.some((m) => A.micPattern(m) === 'omni')) add('warn', '무지향 마이크는 하울링에 취약합니다. 카디오이드 계열로 바꾸면 잔향 수음이 약 5 dB 줄어듭니다.');
    if (sim.rt > 0.6) add('warn', `잔향시간이 ${fmt(sim.rt, 2)}초로 합주실 권장(0.3–0.45초)보다 깁니다. <b>흡음재 추천</b>으로 어디에 붙일지 확인하세요.`);
    else if (sim.rt < 0.25) add('info', `잔향시간 ${fmt(sim.rt, 2)}초로 이미 충분히 흡음된 방입니다. 흡음재보다 배치·볼륨·EQ가 효과적입니다.`);
    if (sim.rtLow > 1.6 * sim.rt && sim.rtLow > 0.5) add('warn', `저역 잔향(${fmt(sim.rtLow, 2)}초)이 중역보다 깁니다 — 웅웅거림. 모서리 베이스트랩이 효과적입니다.`);
    if (state.mics.length > 1) add('info', `마이크 ${state.mics.length}개가 동시에 열려 있으면 여유가 약 ${fmt(10 * Math.log10(state.mics.length))} dB 줄어듭니다. 쓰지 않는 마이크는 뮤트하세요.`);
    if (sim.hasLoop && sim.margin < req + 3 && sim.peaks.length) add('info', `EQ 링아웃: <b>${sim.peaks.map((p) => fmtHz(p.f)).join(', ')}</b> 부근을 좁은 대역(Q≈8)으로 3–6 dB 컷하면 여유를 더 확보할 수 있습니다.`);
    if (sim.hasLoop && sim.margin < req) {
      const list = state.speakers.map((s, k) => (isRouted(s) ? `${spkLabel(k)} ${Math.floor(safeVolume(s.volume, sim.margin, req))}%` : null)).filter(Boolean).join(', ');
      add('warn', `배치를 그대로 두려면 PA 볼륨을 ${fmt(req - sim.margin)} dB 낮추세요 → ${list} <button class="icon" data-action="safe-vol">권장 볼륨 적용</button>`);
    }
    $('#advice').innerHTML = items.join('');
  }

  // ------------------------------------------------------------ 사이드바 렌더링
  const optionsHtml = (list, val) => Object.entries(list).map(([k, v]) => `<option value="${k}"${k === val ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
  const numField = (labelText, field, v, step, extra) => `<label>${labelText}<input type="number" step="${step}" data-field="${field}" value="${v}" ${extra || ''}></label>`;
  const dirField = (labelText, field, v, lo, hi, hint) => `<label>${labelText}${hint ? ` <span class="sub">${hint}</span>` : ''}
      <div class="dir-row"><input type="range" min="${lo}" max="${hi}" step="1" data-field="${field}" value="${v}"><input type="number" min="${lo}" max="${hi}" step="1" data-field="${field}" value="${v}"></div></label>`;

  function renderSurfaces() {
    $('#surfaceSelects').innerHTML = A.SURFACES.map((s) => `<label>${A.SURFACE_NAMES[s]}<select data-surface="${s}">${optionsHtml(A.MATERIALS, state.room.surfaces[s])}</select></label>`).join('');
  }

  function renderPatchCount() {
    const total = state.room.patches.reduce((a, p) => a + A.clipPatch(state.room, p).area, 0);
    $('#patchCount').textContent = state.room.patches.length ? `(${state.room.patches.length}개 · ${fmt(total)} m²)` : '';
  }

  function renderPatches() {
    const absorbers = Object.fromEntries(A.ABSORBERS.concat(['acoustic']).map((k) => [k, A.MATERIALS[k]]));
    const surfOpts = Object.fromEntries(A.SURFACES.map((s) => [s, { name: A.SURFACE_NAMES[s] }]));
    $('#patchList').innerHTML = state.room.patches.length ? state.room.patches.map((p) => `
      <div class="row-item patch" data-kind="patch" data-id="${p.id}">
        <label>표면<select data-field="surface">${optionsHtml(surfOpts, p.surface)}</select></label>
        <label><span><span class="swatch" style="background:${PATCH_COLORS[p.type] || '#2b8a3e'}"></span>종류</span><select data-field="type">${optionsHtml(absorbers, p.type)}</select></label>
        <button class="icon" data-action="del" title="삭제">✕</button>
        <div class="dims">
          ${numField('가로 (m)', 'w', r2(p.w), 0.1, 'min="0.1"')}
          ${numField('세로 (m)', 'h', r2(p.h), 0.1, 'min="0.1"')}
          ${numField('가로 위치', 'u', r2(p.u), 0.1)}
          ${numField(p.surface === 'floor' || p.surface === 'ceil' ? '세로 위치' : '높이 (중심)', 'v', r2(p.v), 0.1)}
        </div>
      </div>`).join('') : '<p class="hint">아직 붙인 흡음재가 없습니다. 아래 "흡음재 추천"으로 자동 제안을 받을 수 있습니다.</p>';
    renderPatchCount();
  }

  function renderPeople() {
    $('#peopleList').innerHTML = state.people.map((p) => p.vocal ? `
      <div class="row-item person vocal${isSel('person', p.id) ? ' selected' : ''}" data-kind="person" data-id="${p.id}">
        <label class="nm">이름<input type="text" data-field="name" value="${esc(p.name)}"></label>
        <span class="follow">🎤 ${state.mics[0] ? micLabel(0) + ' 위치를 따라감' : '마이크 없음'}</span>
        ${numField('귀 높이', 'z', p.z, 0.1, 'min="0.5" max="2.2"')}
        <button class="icon" data-action="del" title="삭제">✕</button>
      </div>` : `
      <div class="row-item person${isSel('person', p.id) ? ' selected' : ''}" data-kind="person" data-id="${p.id}">
        <label class="nm">이름<input type="text" data-field="name" value="${esc(p.name)}"></label>
        ${numField('X (m)', 'x', r2(p.x), 0.1)}
        ${numField('Y (m)', 'y', r2(p.y), 0.1)}
        ${numField('귀 높이', 'z', p.z, 0.1, 'min="0.5" max="2.2"')}
        <button class="icon" data-action="del" title="삭제">✕</button>
      </div>`).join('');
    $('#peopleCount').textContent = `(${state.people.length}명)`;
  }

  function renderLists() {
    $('#spkList').innerHTML = state.speakers.map((s, i) => {
      const routed = isRouted(s);
      return `
      <div class="obj spk${routed ? '' : ' inst'}${isSel('spk', s.id) ? ' selected' : ''}" data-kind="spk" data-id="${s.id}">
        <div class="obj-head"><span class="tag">${spkLabel(i)}</span><input class="name" data-field="name" value="${esc(s.name)}" aria-label="이름">
          <span class="role ${routed ? 'pa' : 'inst'}">${routed ? '보컬 PA' : '악기 앰프'}</span>
          <button class="icon" data-action="del" title="삭제">✕</button></div>
        <label>모델 프리셋<select data-field="model">${optionsHtml(A.SPEAKER_MODELS, s.model || 'custom')}</select></label>
        <label>타입<select data-field="type">${optionsHtml(A.SPEAKER_TYPES, s.type)}</select></label>
        <div class="grid3">
          ${numField('정격 출력 (W)', 'power', s.power, 10, 'min="1" max="10000"')}
          ${numField('감도 (dB/1W/1m)', 'sens', s.sens, 1, 'min="70" max="120"')}
          <label>최대 음압<input type="text" data-out="maxspl" disabled></label>
        </div>
        <label class="check route"><input type="checkbox" data-field="routed"${routed ? ' checked' : ''}> 🎤 보컬(마이크) 신호 출력 — 하울링 계산에 포함</label>
        <div class="grid3">
          ${numField('X 길이 (m)', 'x', r2(s.x), 0.1)}
          ${numField('Y 폭 (m)', 'y', r2(s.y), 0.1)}
          ${numField('Z 높이 (m)', 'z', r2(s.z), 0.1)}
        </div>
        ${dirField('좌우 방향 (°)', 'yaw', Math.round(s.yaw), -180, 180, '0°=B벽 쪽, 90°=D벽 쪽')}
        ${dirField('상하 각도 (°)', 'pitch', Math.round(s.pitch), -90, 90, '+ 위로 · − 아래로')}
        <label>볼륨 (노브 위치)
          <div class="vol-row"><input type="range" min="0" max="100" step="1" data-field="volume" value="${s.volume}"><output data-out="vol"></output></div>
        </label>
        <div class="safe-vol" data-out="safe"></div>
      </div>`;
    }).join('');
    $('#micList').innerHTML = state.mics.map((m, i) => `
      <div class="obj mic${isSel('mic', m.id) ? ' selected' : ''}" data-kind="mic" data-id="${m.id}">
        <div class="obj-head"><span class="tag">${micLabel(i)}</span><input class="name" data-field="name" value="${esc(m.name)}" aria-label="이름">
          <button class="icon" data-action="del" title="삭제">✕</button></div>
        <label>마이크 모델<select data-field="model">${optionsHtml(A.MIC_MODELS, m.model)}</select></label>
        <div class="sub" data-out="micinfo"></div>
        <div class="grid3">
          ${numField('X 길이 (m)', 'x', r2(m.x), 0.1)}
          ${numField('Y 폭 (m)', 'y', r2(m.y), 0.1)}
          ${numField('Z 높이 (m)', 'z', r2(m.z), 0.05)}
        </div>
        ${dirField('좌우 방향 (°)', 'yaw', Math.round(m.yaw), -180, 180, '마이크가 보컬 입을 향하는 방향')}
        ${dirField('상하 각도 (°)', 'pitch', Math.round(m.pitch), -90, 90, '+ 위로')}
      </div>`).join('');
    $('#spkCount').textContent = `(${state.speakers.length})`;
    $('#micCount').textContent = `(${state.mics.length})`;
    renderPeople();
    renderPatches();
    syncInputs();
  }

  const DECIMALS = { x: 2, y: 2, z: 2, yaw: 0, pitch: 0, power: 0, sens: 0, volume: 0, u: 2, v: 2, w: 2, h: 2 };
  function findObj(kind, id) {
    const list = kind === 'spk' ? state.speakers : kind === 'mic' ? state.mics : kind === 'person' ? state.people : state.room.patches;
    return list.find((x) => x.id === id);
  }
  function syncInputs() {
    const active = document.activeElement;
    document.querySelectorAll('[data-kind]').forEach((card) => {
      const o = findObj(card.dataset.kind, card.dataset.id);
      if (!o) return;
      card.querySelectorAll('[data-field]').forEach((inp) => {
        if (inp === active) return;
        const f = inp.dataset.field;
        if (f in DECIMALS && inp.type !== 'checkbox') {
          const v = +(+o[f]).toFixed(DECIMALS[f]);
          if (+inp.value !== v) inp.value = v;
        }
      });
      if (card.dataset.kind === 'spk') {
        const vdb = A.volumeDb(o.volume, state.adv.taper);
        card.querySelector('[data-out="vol"]').innerHTML = `${Math.round(o.volume)}% <small>(${Number.isFinite(vdb) ? fmt(vdb) + ' dB' : '음소거'})</small>`;
        card.querySelector('[data-out="maxspl"]').value = `${fmt(o.sens + 10 * Math.log10(Math.max(1e-6, o.power)), 0)} dB@1m`;
        const safe = card.querySelector('[data-out="safe"]');
        const lvl = A.speakerLevel1m(o, state.adv.taper);
        if (sim && isRouted(o) && o.volume > 0 && sim.hasLoop) {
          const on = onsetVolume(o.volume, sim.margin);
          const rec = safeVolume(o.volume, sim.margin, +state.adv.reqMargin);
          safe.innerHTML = `하울링 시작 ≈ <b>${on >= 100 ? '100% 초과' : Math.floor(on) + '%'}</b> · 권장 최대 ≈ <b>${rec >= 100 ? '100%' : Math.floor(rec) + '%'}</b> · 1m 음압 ${fmt(lvl, 0)} dB`;
        } else if (sim && !isRouted(o)) {
          const idx = state.speakers.indexOf(o);
          const b = sim.bleed.per.filter((x) => x.si === idx).sort((a, c) => c.db - a.db)[0];
          safe.innerHTML = `하울링 루프 밖 · 마이크 유입 <b>${b ? sgn(b.db) + ' dB' : '–'}</b> (보컬 대비) · 1m 음압 ${fmt(lvl, 0)} dB`;
        } else safe.textContent = '';
      }
      if (card.dataset.kind === 'mic') {
        const pattern = A.micPattern(o);
        const n = A.micNullAngle(pattern);
        card.querySelector('[data-out="micinfo"]').textContent = `${A.MIC_PATTERNS[pattern].name}${n ? ` · 감도 최저점 약 ${Math.round(n)}°` : ''}${o.model === 'beta58a' || o.model === 'sm58' ? ' · 4–6 kHz 프레즌스 상승' : ''}`;
      }
      card.classList.toggle('selected', isSel(card.dataset.kind, o.id));
    });
  }

  function renderStaticInputs() {
    document.querySelectorAll('[data-room]').forEach((el) => { el.value = state.room[el.dataset.room]; });
    document.querySelectorAll('[data-adv]').forEach((el) => { el.value = state.adv[el.dataset.adv]; });
    renderSurfaces();
    $('#heatMode').value = state.heat;
    $('#optPA').checked = state.opt.pa;
    $('#optInst').checked = state.opt.inst;
    $('#optMic').checked = state.opt.mic;
    $('#optWeight').value = state.opt.weight;
    $('#absorbBudget').value = state.absorb.budget;
    $('#absorbAdd').value = state.absorb.add;
  }

  function clampObjects() {
    const { L, W, H } = state.room;
    for (const o of [...state.speakers, ...state.mics]) {
      o.x = clamp(o.x, 0.05, L - 0.05);
      o.y = clamp(o.y, 0.05, W - 0.05);
      o.z = clamp(o.z, 0.05, H - 0.05);
    }
    for (const p of state.people) { p.x = clamp(p.x, 0.1, L - 0.1); p.y = clamp(p.y, 0.1, W - 0.1); }
  }

  function invalidatePlan() {
    if (absorbPlan) {
      absorbPlan = null;
      $('#absorbResult').innerHTML = '<p class="hint">설정이 바뀌어 추천 미리보기를 지웠습니다. 다시 계산하세요.</p>';
      $('#btnAbsorbApply').hidden = true;
      $('#btnAbsorbClear').hidden = true;
    }
  }

  // ------------------------------------------------------------ 이벤트: 사이드바
  function onListInput(e) {
    const inp = e.target.closest('[data-field]');
    if (!inp) return;
    const card = inp.closest('[data-kind]');
    const kind = card.dataset.kind;
    const o = findObj(kind, card.dataset.id);
    if (!o) return;
    const f = inp.dataset.field;
    let rerender = false;
    if (f === 'name') {
      o.name = inp.value;
    } else if (f === 'routed') {
      o.routed = inp.checked; rerender = true;
    } else if (f === 'model' && kind === 'spk') {
      o.model = inp.value;
      const m = A.SPEAKER_MODELS[inp.value];
      if (m && m.type) { Object.assign(o, { type: m.type, power: m.power, sens: m.sens, routed: m.routed !== false }); rerender = true; }
    } else if (f === 'model' && kind === 'mic') {
      o.model = inp.value;
    } else if (f === 'type' && kind === 'spk') {
      o.type = inp.value; o.model = 'custom';
      if (inp.value === 'ceiling') { o.z = r2(state.room.H - 0.05); o.pitch = -90; }
      rerender = true;
    } else if (f === 'type' || f === 'surface') {
      o[f] = inp.value; invalidatePlan(); rerender = true;
    } else {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return;
      if (f === 'yaw') o.yaw = normYaw(v);
      else if (f === 'pitch') o.pitch = clamp(v, -90, 90);
      else if (f === 'volume') o.volume = clamp(v, 0, 100);
      else if (f === 'power') { o.power = Math.max(0.1, v); o.model = 'custom'; }
      else if (f === 'sens') { o.sens = v; o.model = 'custom'; }
      else if (f === 'w' || f === 'h') o[f] = Math.max(0.05, v);
      else o[f] = v;
      if (kind === 'patch') { invalidatePlan(); renderPatchCount(); }
      clampObjects();
      card.querySelectorAll(`[data-field="${f}"]`).forEach((x) => { if (x !== inp) x.value = Math.round(o[f] * 100) / 100; });
      if (kind === 'spk' && (f === 'power' || f === 'sens')) { const sel = card.querySelector('[data-field="model"]'); if (sel) sel.value = 'custom'; }
    }
    if (kind !== 'patch') selected = { kind, id: o.id };
    if (rerender) { if (kind === 'patch') renderPatches(); else renderLists(); }
    requestUpdate();
  }

  function onListClick(e) {
    const card = e.target.closest('[data-kind]');
    if (!card) return;
    const kind = card.dataset.kind;
    if (e.target.closest('[data-action="del"]')) {
      const list = kind === 'spk' ? state.speakers : kind === 'mic' ? state.mics : kind === 'person' ? state.people : state.room.patches;
      if ((kind === 'spk' || kind === 'mic') && list.length <= 1) { toast(kind === 'spk' ? '스피커는 최소 1개가 필요합니다.' : '마이크는 최소 1개가 필요합니다.'); return; }
      list.splice(list.findIndex((x) => x.id === card.dataset.id), 1);
      if (kind === 'patch') invalidatePlan();
      renderLists();
      requestUpdate();
      return;
    }
    if (kind === 'patch') return;
    const prev = selected && selected.id;
    selected = { kind, id: card.dataset.id };
    if (prev !== selected.id) {
      syncInputs();
      document.querySelectorAll('.row-item.person').forEach((r) => r.classList.toggle('selected', isSel('person', r.dataset.id)));
      drawAll();
      if (state.heat !== 'none' && kind === 'mic') scheduleHeat();
    }
  }

  // ------------------------------------------------------------ 이벤트: 캔버스
  let drag = null;
  function canvasPoint(cv, e) {
    const r = cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function planHit(px, py) {
    const g = planGeom;
    if (!g) return null;
    const P = (x, y) => [g.ox + x * g.s, g.oy + (g.W - y) * g.s];
    const cands = [];
    state.speakers.forEach((o) => {
      const [cx, cy] = P(o.x, o.y);
      if (o.type !== 'ceiling' && Math.abs(o.pitch) < 85) {
        const a = -o.yaw * Math.PI / 180;
        cands.push({ kind: 'spk', o, part: 'rot', d: Math.hypot(px - (cx + Math.cos(a) * HANDLE_SPK), py - (cy + Math.sin(a) * HANDLE_SPK)), r: 12 });
      }
      cands.push({ kind: 'spk', o, part: 'body', d: Math.hypot(px - cx, py - cy), r: Math.max(16, 0.3 * g.s) });
    });
    state.mics.forEach((o) => {
      const [cx, cy] = P(o.x, o.y);
      const a = -o.yaw * Math.PI / 180;
      cands.push({ kind: 'mic', o, part: 'rot', d: Math.hypot(px - (cx + Math.cos(a) * HANDLE_MIC), py - (cy + Math.sin(a) * HANDLE_MIC)), r: 12 });
      cands.push({ kind: 'mic', o, part: 'body', d: Math.hypot(px - cx, py - cy), r: 15 });
    });
    state.people.forEach((o) => {
      if (o.vocal) return;
      const [cx, cy] = P(o.x, o.y);
      cands.push({ kind: 'person', o, part: 'body', d: Math.hypot(px - cx, py - cy), r: Math.max(11, 0.2 * g.s), low: true });
    });
    const hits = cands.filter((c) => c.d <= c.r).sort((a, b) => (a.part !== b.part ? (a.part === 'rot' ? -1 : 1) : (!!a.low !== !!b.low ? (a.low ? 1 : -1) : a.d - b.d)));
    return hits[0] || null;
  }

  function sideHit(px, py) {
    const g = sideGeom;
    if (!g) return null;
    const P = (x, z) => [g.ox + x * g.s, g.oy + (g.H - z) * g.s];
    const cands = [];
    state.speakers.forEach((o) => {
      const [cx, cy] = P(o.x, o.z);
      const [hx, hy] = sideHandle(o, 34, P);
      if (o.type !== 'ceiling') cands.push({ kind: 'spk', o, part: 'pitch', d: Math.hypot(px - hx, py - hy), r: 11 });
      cands.push({ kind: 'spk', o, part: 'body', d: Math.hypot(px - cx, py - cy), r: 15 });
    });
    state.mics.forEach((o) => {
      const [cx, cy] = P(o.x, o.z);
      const [hx, hy] = sideHandle(o, 28, P);
      cands.push({ kind: 'mic', o, part: 'pitch', d: Math.hypot(px - hx, py - hy), r: 11 });
      cands.push({ kind: 'mic', o, part: 'body', d: Math.hypot(px - cx, py - cy), r: 14 });
    });
    const hits = cands.filter((c) => c.d <= c.r).sort((a, b) => (a.part === b.part ? a.d - b.d : a.part === 'pitch' ? -1 : 1));
    return hits[0] || null;
  }

  function bindCanvas(cv, view) {
    cv.addEventListener('pointerdown', (e) => {
      const [px, py] = canvasPoint(cv, e);
      const hit = view === 'plan' ? planHit(px, py) : sideHit(px, py);
      if (!hit) return;
      e.preventDefault();
      cv.setPointerCapture(e.pointerId);
      const prevSel = selected && selected.id;
      selected = { kind: hit.kind, id: hit.o.id };
      let off = [0, 0];
      if (hit.part === 'body') {
        if (view === 'plan') off = [hit.o.x - (px - planGeom.ox) / planGeom.s, hit.o.y - (planGeom.W - (py - planGeom.oy) / planGeom.s)];
        else off = [hit.o.x - (px - sideGeom.ox) / sideGeom.s, hit.o.z - (sideGeom.H - (py - sideGeom.oy) / sideGeom.s)];
      }
      drag = { view, hit, off, moved: false };
      if (prevSel !== selected.id) {
        syncInputs();
        document.querySelectorAll('.row-item.person').forEach((r) => r.classList.toggle('selected', isSel('person', r.dataset.id)));
        drawAll();
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const [px, py] = canvasPoint(cv, e);
      if (!drag || drag.view !== view) {
        const hit = view === 'plan' ? planHit(px, py) : sideHit(px, py);
        cv.style.cursor = hit ? (hit.part === 'body' ? 'move' : 'crosshair') : 'default';
        return;
      }
      const o = drag.hit.o;
      const { L, W, H } = state.room;
      if (view === 'plan') {
        const g = planGeom;
        const cx = g.ox + o.x * g.s, cy = g.oy + (g.W - o.y) * g.s;
        if (drag.hit.part === 'rot') {
          let yaw = Math.atan2(-(py - cy), px - cx) * 180 / Math.PI;
          if (e.shiftKey) yaw = Math.round(yaw / 15) * 15;
          o.yaw = normYaw(Math.round(yaw));
        } else {
          o.x = clamp((px - g.ox) / g.s + drag.off[0], 0.05, L - 0.05);
          o.y = clamp(g.W - (py - g.oy) / g.s + drag.off[1], 0.05, W - 0.05);
        }
      } else {
        const g = sideGeom;
        const cx = g.ox + o.x * g.s, cy = g.oy + (g.H - o.z) * g.s;
        if (drag.hit.part === 'pitch') {
          const dx = px - cx, up = -(py - cy);
          let pitch = Math.atan2(up, Math.abs(dx)) * 180 / Math.PI;
          if (e.shiftKey) pitch = Math.round(pitch / 15) * 15;
          o.pitch = clamp(Math.round(pitch), -90, 90);
          const facing = Math.cos(o.yaw * Math.PI / 180);
          if (Math.abs(dx) > 8 && Math.sign(dx) !== Math.sign(facing || 1)) o.yaw = normYaw(180 - o.yaw);
        } else {
          o.x = clamp((px - g.ox) / g.s + drag.off[0], 0.05, L - 0.05);
          o.z = clamp(g.H - (py - g.oy) / g.s + drag.off[1], 0.05, H - 0.05);
        }
      }
      drag.moved = true;
      requestUpdate({ heat: false });
    });
    const end = () => {
      if (drag && drag.view === view) {
        const moved = drag.moved;
        drag = null;
        if (moved) { invalidatePlan(); requestUpdate(); } else if (state.heat !== 'none') scheduleHeat();
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  function bindChart() {
    const cv = $('#chart');
    cv.addEventListener('pointermove', (e) => {
      if (!chartGeom || !sim) return;
      const [px] = canvasPoint(cv, e);
      const { padL, padR, w, fmin, fmax } = chartGeom;
      if (px < padL || px > w - padR) { chartHover = null; drawChart(); return; }
      const f = fmin * Math.pow(fmax / fmin, (px - padL) / (w - padL - padR));
      let best = 0;
      sim.freqs.forEach((x, i) => { if (Math.abs(Math.log(x / f)) < Math.abs(Math.log(sim.freqs[best] / f))) best = i; });
      chartHover = best;
      drawChart();
    });
    cv.addEventListener('pointerleave', () => { chartHover = null; drawChart(); });
  }

  // ------------------------------------------------------------ 자동 배치
  function setBusy(on) {
    busy = on;
    ['#btnOptimize', '#btnOptMic', '#btnAbsorb', '#btnAbsorbMore'].forEach((s) => { $(s).disabled = on; });
  }

  function runOptimize(micOnly) {
    if (busy) return;
    const o = state.opt;
    const flags = micOnly ? { optPA: false, optInst: false, optMic: true } : { optPA: o.pa, optInst: o.inst, optMic: o.mic };
    if (!flags.optPA && !flags.optInst && !flags.optMic) { $('#optResult').innerHTML = '<span class="down">최적화할 대상을 하나 이상 선택하세요.</span>'; return; }
    const cfg = {
      speakers: state.speakers.map((s) => Object.assign({}, s, { yaw: normYaw(s.yaw) })),
      mics: state.mics.map((m) => Object.assign({}, m, { yaw: normYaw(m.yaw) })),
      people: state.people.map((p) => Object.assign({}, p)),
    };
    const optimizer = A.createOptimizer(engineRoom(), cfg, Object.assign(flags, {
      weight: +o.weight, reqMargin: +state.adv.reqMargin, lref: +state.adv.lref, micHpf: +state.adv.micHpf, taper: state.adv.taper,
      seed: (Date.now() & 0xffff) + 1,
    }));
    if (optimizer.noParams) { $('#optResult').innerHTML = '<span class="down">최적화할 대상이 없습니다 (해당 종류의 스피커가 없음).</span>'; return; }
    setBusy(true);
    const btn = micOnly ? $('#btnOptMic') : $('#btnOptimize');
    const oldText = btn.textContent;
    btn.textContent = '계산 중…';
    const bar = $('#optProgress');
    bar.hidden = false;
    $('#optResult').innerHTML = `<span class="muted">${micOnly ? '마이크 위치·방향만' : '배치를'} 수천 가지로 시뮬레이션하고 있습니다…</span>`;
    const tick = () => {
      optimizer.step(35);
      bar.firstElementChild.style.width = (optimizer.progress * 100).toFixed(1) + '%';
      if (!optimizer.done) setTimeout(tick, 0);
      else { btn.textContent = oldText; finishOptimize(optimizer.result, micOnly, flags); }
    };
    setTimeout(tick, 30);
  }

  function finishOptimize(res, micOnly, flags) {
    setBusy(false);
    $('#optProgress').hidden = true;
    const req = +state.adv.reqMargin;
    undoSnapshot = JSON.parse(JSON.stringify({ speakers: state.speakers, mics: state.mics }));
    if (!res.keptCurrent) {
      res.config.speakers.forEach((s, i) => Object.assign(state.speakers[i], { x: r2(s.x), y: r2(s.y), z: r2(s.z), yaw: normYaw(Math.round(s.yaw)), pitch: Math.round(s.pitch) }));
      res.config.mics.forEach((m, i) => Object.assign(state.mics[i], { x: r2(m.x), y: r2(m.y), z: r2(m.z), yaw: normYaw(Math.round(m.yaw)), pitch: Math.round(m.pitch) }));
      invalidatePlan();
    }
    $('#btnUndo').hidden = res.keptCurrent;
    simulate();
    const rows = [
      ['안정 여유', `${fmt(res.before.margin)} dB`, `${fmt(sim.margin)} dB`, sim.margin - res.before.margin],
      ['멤버 위치 PA 음압 편차', `±${fmt(res.before.coverage.stdSpl)} dB`, `±${fmt(sim.cov.stdSpl)} dB`, res.before.coverage.stdSpl - sim.cov.stdSpl],
      ['악기 소리 마이크 유입', `${sgn(res.before.bleed)} dB`, `${sgn(sim.bleed.db)} dB`, (res.before.bleed || 0) - (sim.bleed.db || 0)],
    ];
    let html = res.keptCurrent
      ? '<b>현재 배치가 이미 탐색한 후보 중 가장 좋습니다.</b>'
      : `<b>${micOnly ? '마이크 위치·방향을' : '최적 배치를'} 적용했습니다.</b> (${res.evals.toLocaleString()}개 배치 시뮬레이션${micOnly ? '' : ' · 스피커는 모두 벽에 붙임'})`;
    if (!res.keptCurrent) {
      const moved = [];
      state.mics.forEach((m, i) => moved.push(`${micLabel(i)}: (${fmt(m.x, 2)}, ${fmt(m.y, 2)}) m, 방향 ${Math.round(m.yaw)}° → 보컬은 ${Math.round(normYaw(m.yaw + 180))}° 방향을 바라봄`));
      state.speakers.forEach((s, i) => {
        if ((isRouted(s) && flags.optPA) || (!isRouted(s) && flags.optInst)) moved.push(`${spkLabel(i)}: <b>${A.nearestWall(state.room, s.x, s.y)}벽</b> (${fmt(s.x, 2)}, ${fmt(s.y, 2)}), 높이 ${fmt(s.z, 2)} m, 좌우 ${Math.round(s.yaw)}°, 상하 ${Math.round(s.pitch)}°`);
      });
      html += `<ul class="absorb-totals">${moved.map((t) => `<li>${t}</li>`).join('')}</ul>`;
    }
    html += `<table><tr><th>지표</th><th>이전</th><th>최적화 후</th><th></th></tr>${rows.map(([n, a, b, d]) => `<tr><td>${n}</td><td>${a}</td><td>${b}</td><td class="${d >= 0.05 ? 'up' : d <= -0.05 ? 'down' : ''}">${d >= 0.05 ? '▲' : d <= -0.05 ? '▼' : '–'}</td></tr>`).join('')}</table>`;
    if (sim.hasLoop && sim.margin < req) {
      const list = state.speakers.map((s, k) => (isRouted(s) ? `${spkLabel(k)} ${Math.floor(safeVolume(s.volume, sim.margin, req))}%` : null)).filter(Boolean).join(', ');
      html += `<p class="down">배치만으로는 필요 여유(${req} dB)를 확보할 수 없습니다. PA 볼륨을 ${fmt(req - sim.margin)} dB 낮추거나(→ ${list}) 흡음재를 추가하세요. <button class="icon" data-action="safe-vol">권장 볼륨 적용</button></p>`;
    } else if (sim.hasLoop) html += `<p class="up">필요 여유 ${req} dB를 확보했습니다.</p>`;
    $('#optResult').innerHTML = html;
    requestUpdate();
  }

  function applySafeVolume() {
    if (!sim || !sim.hasLoop) return;
    const req = +state.adv.reqMargin;
    const m = sim.margin;
    state.speakers.forEach((s) => { if (isRouted(s)) s.volume = Math.floor(safeVolume(s.volume, m, req)); });
    requestUpdate();
  }

  // ------------------------------------------------------------ 흡음재 추천
  function describeAmount(p) {
    const area = p.area != null ? p.area : A.clipPatch(state.room, p).area;
    switch (p.type) {
      case 'panel50':
      case 'panel100': return `60×120cm 패널 <b>${Math.max(1, Math.round(area / A.PANEL_AREA))}장</b> (${fmt(area)} m²)`;
      case 'foam25': return `<b>${fmt(area)} m²</b> (50×50cm 약 ${Math.ceil(area / 0.25)}장)`;
      case 'curtain': return `폭 <b>${fmt(p.w)} m</b> × 높이 ${fmt(p.h)} m`;
      case 'basstrap': return `<b>1개</b> (폭 ${fmt(p.w)} m × 높이 ${fmt(p.h)} m)`;
      case 'carpet': return `<b>${fmt(p.w)} × ${fmt(p.h)} m</b> 러그`;
      default: return `${fmt(area)} m²`;
    }
  }
  function describeLocation(p) {
    const c = A.clipPatch(state.room, p);
    const rng = (a, b) => `${fmt(a)}–${fmt(b)} m`;
    if (p.type === 'basstrap') {
      const other = c.u < state.room.W / 2 ? 'C' : 'D';
      return `<b>${p.surface}벽–${other}벽 모서리</b>, 바닥부터 천장까지`;
    }
    if (p.surface === 'A' || p.surface === 'B') return `<b>${A.SURFACE_NAMES[p.surface]}</b> · C벽 쪽 끝에서 ${rng(c.u0, c.u1)}, 높이 ${rng(c.v0, c.v1)}`;
    if (p.surface === 'C' || p.surface === 'D') return `<b>${A.SURFACE_NAMES[p.surface]}</b> · A벽 쪽 끝에서 ${rng(c.u0, c.u1)}, 높이 ${rng(c.v0, c.v1)}`;
    return `<b>${A.SURFACE_NAMES[p.surface]}</b> · A벽에서 ${rng(c.u0, c.u1)}, C벽에서 ${rng(c.v0, c.v1)}`;
  }
  function describeReason(st) {
    const r = st.reason || {};
    if (r.kind === 'reflection') {
      const si = state.speakers.findIndex((s) => s.id === r.spk.id), mi = state.mics.findIndex((m) => m.id === r.mic.id);
      return `${si >= 0 ? spkLabel(si) : '스피커'} → ${mi >= 0 ? micLabel(mi) : '마이크'} <b>1차 반사 지점</b> (하울링 경로 차단)`;
    }
    if (r.kind === 'corner') return '저음 잔향(웅웅거림) 감소';
    if (st.surface === 'floor') return '바닥 반사·잔향 감소';
    return '잔향시간 감소';
  }

  // mode: 'new' = 처음부터 추천, 'more' = 붙인 흡음재 + 현재 추천 위에 입력한 면적만큼 추가
  function runAbsorb(mode) {
    if (busy) return;
    const more = mode === 'more';
    const budget = more ? clamp(+state.absorb.add || 2, 0.5, 50) : clamp(+state.absorb.budget || 12, 0.5, 100);
    const room = engineRoom();
    if (more && absorbPlan) room.patches = state.room.patches.concat(absorbPlan.steps.map((st) => ({ surface: st.surface, type: st.type, u: st.u, v: st.v, w: st.w, h: st.h })));
    const planner = A.createAbsorberPlanner(room, state.speakers, state.mics, {
      budget, reqMargin: +state.adv.reqMargin, lref: +state.adv.lref, micHpf: +state.adv.micHpf, taper: state.adv.taper,
      minGain: more ? 0.02 : 0.2, maxSteps: more ? 20 : 12,
    });
    setBusy(true);
    const bar = $('#absorbProgress');
    bar.hidden = false;
    if (!more || !absorbPlan) $('#absorbResult').innerHTML = `<span class="muted">${more ? `${fmt(budget)} m²를 붙일 다음 위치를` : '벽·천장·바닥의 후보 위치를'} 시뮬레이션하고 있습니다…</span>`;
    const tick = () => {
      const done = planner.step();
      bar.firstElementChild.style.width = (planner.progress * 100).toFixed(1) + '%';
      if (!done) setTimeout(tick, 0);
      else finishAbsorb(planner.result, budget, more);
    };
    setTimeout(tick, 30);
  }

  function finishAbsorb(res, budget, more) {
    setBusy(false);
    $('#absorbProgress').hidden = true;
    let notice = null;
    if (!more) {
      absorbPlan = res.steps.length
        ? { steps: res.steps.map((st) => Object.assign({}, st, { batch: 0 })), start: res.start, end: res.end, usedArea: res.usedArea, batches: [{ budget, used: res.usedArea }] }
        : null;
      if (!absorbPlan) {
        $('#absorbResult').innerHTML = `<p>추가 흡음재로 얻을 수 있는 개선이 거의 없습니다 (현재 RT60 ${fmt(res.start.rtMid, 2)}초${Number.isFinite(res.start.margin) ? `, 하울링 여유 ${fmt(res.start.margin)} dB` : ''}). 배치·볼륨·EQ 조정이 더 효과적입니다.</p>`;
        $('#btnAbsorbApply').hidden = true; $('#btnAbsorbClear').hidden = true;
        drawAll();
        return;
      }
    } else if (!res.steps.length) {
      notice = { ok: false, html: `입력한 ${fmt(budget)} m²를 더 붙일 만한 곳이 없습니다. 더 붙여도 하울링 여유·잔향시간이 거의 좋아지지 않거나 방이 너무 건조해집니다 (현재 RT60 ${fmt(res.start.rtMid, 2)}초). 배치·볼륨·EQ 조정을 권장합니다.` };
      toast('추가로 붙일 만한 곳이 없습니다.');
      if (!absorbPlan) {
        $('#absorbResult').innerHTML = `<p class="absorb-notice">${notice.html}</p>`;
        drawAll();
        return;
      }
    } else {
      if (!absorbPlan) absorbPlan = { steps: [], start: res.start, end: res.start, usedArea: 0, batches: [{ budget: 0, used: 0, applied: true }] };
      const batch = absorbPlan.batches.length;
      absorbPlan.steps = absorbPlan.steps.concat(res.steps.map((st) => Object.assign({}, st, { batch })));
      absorbPlan.end = res.end;
      absorbPlan.usedArea += res.usedArea;
      absorbPlan.batches.push({ budget, used: res.usedArea });
      const first = absorbPlan.steps.length - res.steps.length + 1;
      const range = res.steps.length > 1 ? `${first}–${absorbPlan.steps.length}번` : `${first}번`;
      notice = {
        ok: true,
        html: `<b>${fmt(res.usedArea)} m²</b>를 다음으로 좋은 곳(${range})에 추가했습니다${res.usedArea < budget - 0.5 ? ` — 입력한 ${fmt(budget)} m² 중 나머지는 더 붙여도 효과가 없거나 패널 크기 단위(60×120cm) 때문에 남았습니다` : ''}. 하울링 여유 ${fmt(res.start.margin)} → ${fmt(res.end.margin)} dB, 잔향시간 ${fmt(res.start.rtMid, 2)} → ${fmt(res.end.rtMid, 2)}초.`,
      };
    }
    renderAbsorbPlan(notice);
  }

  function renderAbsorbPlan(notice) {
    const plan = absorbPlan;
    const el = $('#absorbResult');
    const req = +state.adv.reqMargin;
    const totals = {};
    plan.steps.forEach((st) => { totals[st.type] = (totals[st.type] || 0) + st.area; });
    const totalText = Object.entries(totals).map(([t, a]) => {
      const n = t === 'panel50' || t === 'panel100' ? ` (60×120cm 약 ${Math.round(a / A.PANEL_AREA)}장)` : t === 'basstrap' ? ` (${plan.steps.filter((st) => st.type === t).length}개)` : '';
      return `<li><span class="swatch" style="background:${PATCH_COLORS[t]}"></span>${esc(A.MATERIALS[t].name)}: <b>${fmt(a)} m²</b>${n}</li>`;
    }).join('');
    const hasLoop = Number.isFinite(plan.start.margin);
    const extra = plan.batches.slice(1).reduce((a, b) => a + b.used, 0);
    const firstUsed = plan.batches[0].applied ? 0 : plan.batches[0].used;
    const areaText = extra > 0
      ? `총 <b>${fmt(plan.usedArea)} m²</b> (${plan.batches[0].applied ? '' : `처음 ${fmt(firstUsed)} + `}추가 ${fmt(extra)} m²)`
      : `총 <b>${fmt(plan.usedArea)} m²</b> / 최대 ${fmt(plan.batches[0].budget)} m²`;
    let html = notice ? `<p class="absorb-notice${notice.ok ? ' ok' : ''}">${notice.html}</p>` : '';
    html += `<div class="absorb-summary">
      ${hasLoop ? `<span>하울링 여유 <b>${fmt(plan.start.margin)} → ${fmt(plan.end.margin)} dB</b></span>` : ''}
      <span>잔향시간(중역) <b>${fmt(plan.start.rtMid, 2)} → ${fmt(plan.end.rtMid, 2)}초</b></span>
      <span>저역 <b>${fmt(plan.start.rtLow, 2)} → ${fmt(plan.end.rtLow, 2)}초</b></span>
      <span>${areaText}</span></div>
      <ul class="absorb-totals">${totalText}</ul>
      <table><tr><th>#</th><th>어디에</th><th>무엇을</th><th>얼마나</th><th>이유</th><th>효과</th></tr>`;
    const multiAdd = plan.batches.length > 2;
    plan.steps.forEach((st, i) => {
      const dm = st.after.margin - st.before.margin;
      const tag = st.batch > 0 ? `<br><span class="tag-add">추가${multiAdd ? ' ' + st.batch : ''}</span>` : '';
      html += `<tr class="${st.batch > 0 ? 'added' : ''}"><td><span class="rank" style="background:${PATCH_COLORS[st.type]}">${i + 1}</span>${tag}</td>
        <td>${describeLocation(st)}</td>
        <td>${esc(A.MATERIALS[st.type].name)}</td>
        <td>${describeAmount(st)}</td>
        <td>${describeReason(st)}</td>
        <td class="num">${hasLoop ? `여유 ${sgn(dm)} dB<br>` : ''}RT ${fmt(st.before.rtMid, 2)}→${fmt(st.after.rtMid, 2)}초</td></tr>`;
    });
    html += '</table>';
    if (hasLoop && plan.end.margin < req) html += `<p class="down">흡음재만으로는 필요 여유(${req} dB)에 못 미칩니다. 배치 최적화·볼륨 조정과 함께 적용하세요.</p>`;
    html += '<p class="hint">평면도·측면도에 번호와 함께 미리보기로 표시됩니다. "추천 모두 적용"을 누르면 (추가분 포함) 모두 붙인 흡음재 목록에 들어갑니다.</p>';
    el.innerHTML = html;
    $('#btnAbsorbApply').hidden = false;
    $('#btnAbsorbClear').hidden = false;
    drawAll();
  }

  // ------------------------------------------------------------ 초기화 및 바인딩
  function bind() {
    ['#spkList', '#micList', '#peopleList', '#patchList'].forEach((sel) => {
      $(sel).addEventListener('input', onListInput);
      $(sel).addEventListener('click', onListClick);
    });
    document.querySelectorAll('[data-room]').forEach((el) => el.addEventListener('input', () => {
      const k = el.dataset.room;
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) return;
      const lim = { L: [2, 40], W: [2, 40], H: [2, 10] }[k];
      state.room[k] = clamp(v, lim[0], lim[1]);
      state.speakers.forEach((s) => { if (s.type === 'ceiling') s.z = r2(state.room.H - 0.05); });
      clampObjects();
      invalidatePlan();
      requestUpdate();
    }));
    $('#surfaceSelects').addEventListener('change', (e) => {
      const s = e.target.dataset.surface;
      if (!s) return;
      state.room.surfaces[s] = e.target.value;
      invalidatePlan();
      requestUpdate();
    });
    document.querySelectorAll('[data-adv]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      if (el.tagName === 'SELECT') state.adv[el.dataset.adv] = el.value;
      else {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) return;
        state.adv[el.dataset.adv] = v;
      }
      invalidatePlan();
      requestUpdate();
    }));
    $('#heatMode').addEventListener('change', (e) => { state.heat = e.target.value; computeHeat(); drawPlan(); save(); });
    $('#optPA').addEventListener('change', (e) => { state.opt.pa = e.target.checked; save(); });
    $('#optInst').addEventListener('change', (e) => { state.opt.inst = e.target.checked; save(); });
    $('#optMic').addEventListener('change', (e) => { state.opt.mic = e.target.checked; save(); });
    $('#optWeight').addEventListener('input', (e) => { state.opt.weight = +e.target.value; save(); });
    $('#absorbBudget').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { state.absorb.budget = v; save(); } });
    $('#btnOptimize').addEventListener('click', () => runOptimize(false));
    $('#btnOptMic').addEventListener('click', () => runOptimize(true));
    $('#btnAbsorb').addEventListener('click', () => runAbsorb('new'));
    $('#btnAbsorbMore').addEventListener('click', () => runAbsorb('more'));
    $('#absorbAdd').addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) { state.absorb.add = v; save(); } });
    $('#btnAbsorbApply').addEventListener('click', () => {
      if (!absorbPlan) return;
      const n = absorbPlan.steps.length;
      absorbPlan.steps.forEach((s) => state.room.patches.push({ id: newId(), surface: s.surface, type: s.type, u: r2(s.u), v: r2(s.v), w: r2(s.w), h: r2(s.h) }));
      absorbPlan = null;
      $('#btnAbsorbApply').hidden = true; $('#btnAbsorbClear').hidden = true;
      $('#absorbResult').innerHTML = `<p class="up">추천 흡음재 ${n}개를 적용했습니다. 왼쪽 "붙인 흡음재"에서 수정할 수 있습니다.</p>`;
      renderPatches();
      requestUpdate();
    });
    $('#btnAbsorbClear').addEventListener('click', () => {
      absorbPlan = null;
      $('#btnAbsorbApply').hidden = true; $('#btnAbsorbClear').hidden = true;
      $('#absorbResult').innerHTML = '';
      drawAll();
    });
    $('#btnUndo').addEventListener('click', () => {
      if (!undoSnapshot) return;
      state.speakers = undoSnapshot.speakers;
      state.mics = undoSnapshot.mics;
      undoSnapshot = null;
      $('#btnUndo').hidden = true;
      $('#optResult').innerHTML = '<span class="muted">이전 배치로 되돌렸습니다.</span>';
      invalidatePlan();
      renderLists();
      requestUpdate();
    });
    document.addEventListener('click', (e) => { if (e.target.closest('[data-action="safe-vol"]')) applySafeVolume(); });
    $('#btnAddSpk').addEventListener('click', () => {
      const n = state.speakers.length;
      const pose = A.perimeterToPose(state.room, (n * 1.7) % (2 * (state.room.L + state.room.W)));
      const s = makeSpeaker('스피커 ' + (n + 1), 'pa12', r2(pose.x), r2(pose.y), Math.min(2.0, state.room.H - 0.3), pose.yaw, -10, 40);
      state.speakers.push(s);
      selected = { kind: 'spk', id: s.id };
      renderLists();
      requestUpdate();
    });
    $('#btnAddMic').addEventListener('click', () => {
      const n = state.mics.length;
      const m = makeMic('마이크 ' + (n + 1), 'beta58a', r2(clamp(state.room.L / 2 - 1 + n * 0.8, 0.5, state.room.L - 0.5)), r2(state.room.W / 2), 1.55, 180, 15);
      state.mics.push(m);
      selected = { kind: 'mic', id: m.id };
      renderLists();
      requestUpdate();
    });
    $('#btnAddPerson').addEventListener('click', () => {
      const p = makePerson('멤버 ' + (state.people.length + 1), r2(state.room.L / 2), r2(state.room.W / 2 + 0.5), 1.5);
      state.people.push(p);
      selected = { kind: 'person', id: p.id };
      renderPeople();
      requestUpdate();
    });
    $('#btnAddPatch').addEventListener('click', () => {
      state.room.patches.push({ id: newId(), surface: 'A', type: 'panel50', u: r2(state.room.W / 2), v: 1.5, w: 1.2, h: 1.2 });
      invalidatePlan();
      renderPatches();
      requestUpdate();
    });
    let resetArmed = null;
    $('#btnReset').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (!resetArmed) {
        btn.textContent = '정말 초기화?';
        btn.classList.add('danger');
        resetArmed = setTimeout(() => { resetArmed = null; btn.textContent = '초기화'; btn.classList.remove('danger'); }, 3000);
        return;
      }
      clearTimeout(resetArmed);
      resetArmed = null;
      btn.textContent = '초기화';
      btn.classList.remove('danger');
      state = defaultState();
      selected = { kind: 'mic', id: state.mics[0].id };
      undoSnapshot = null;
      absorbPlan = null;
      $('#btnUndo').hidden = true; $('#btnAbsorbApply').hidden = true; $('#btnAbsorbClear').hidden = true;
      $('#optResult').innerHTML = ''; $('#absorbResult').innerHTML = '';
      renderStaticInputs();
      renderLists();
      requestUpdate();
      toast('예제 설정으로 초기화했습니다.');
    });
    $('#btnExport').addEventListener('click', () => {
      const json = JSON.stringify(state, null, 2);
      try {
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'howling-setup.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (err) { /* 다운로드가 막힌 환경 */ }
      const done = (copied) => toast(copied ? '설정 JSON을 저장하고 클립보드에도 복사했습니다.' : '설정 JSON 파일을 저장했습니다.');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json).then(() => done(true), () => done(false));
      else done(false);
    });
    $('#fileImport').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then((t) => {
        state = sanitize(JSON.parse(t));
        clampObjects();
        selected = { kind: 'mic', id: state.mics[0].id };
        absorbPlan = null;
        renderStaticInputs();
        renderLists();
        requestUpdate();
        toast('설정을 불러왔습니다.');
      }).catch(() => toast('설정 파일을 읽을 수 없습니다.'));
      e.target.value = '';
    });
    bindCanvas($('#plan'), 'plan');
    bindCanvas($('#side'), 'side');
    bindChart();
    let rT = null;
    window.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(drawAll, 80); });
  }

  bind();
  clampObjects();
  renderStaticInputs();
  renderLists();
  requestUpdate();

  // 디버그/테스트용
  window.HowlSim = { get state() { return state; }, get sim() { return sim; }, get absorbPlan() { return absorbPlan; }, runOptimize, runAbsorb, requestUpdate };
})();
