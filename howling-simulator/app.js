/* 하울링 시뮬레이터 — GUI */
(function () {
  'use strict';
  const A = window.Acoustics;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const STORE_KEY = 'howlsim.v1';
  const SPK_COLOR = '#3b5bdb';
  const MIC_COLOR = '#c2255c';
  const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
  const sgn = (v, d = 1) => (v >= 0 ? '+' : '') + fmt(v, d);
  const fmtHz = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 2).replace(/\.?0+$/, '') + ' kHz' : Math.round(f) + ' Hz');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const normYaw = (y) => { y = ((y + 180) % 360 + 360) % 360 - 180; return y === -180 ? 180 : y; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  let uid = 1;
  const newId = () => 'o' + uid++;

  function makeSpeaker(name, x, y, extra) {
    return Object.assign({ id: newId(), name, type: 'box', power: 200, volume: 35, sens: 92, x, y, z: 2.2, yaw: 0, pitch: -10 }, extra || {});
  }
  function makeMic(name, x, y, extra) {
    return Object.assign({ id: newId(), name, pattern: 'cardioid', x, y, z: 1.5, yaw: 180, pitch: 0 }, extra || {});
  }

  function defaultState() {
    return {
      room: { L: 12, W: 8, H: 3.2, stage: 3, people: 30, wall: 'gypsum', floor: 'carpet', ceil: 'acoustictile' },
      speakers: [makeSpeaker('메인 L', 0.8, 1.5), makeSpeaker('메인 R', 0.8, 6.5)],
      mics: [makeMic('보컬 마이크', 2, 4)],
      adv: { lref: 105, reqMargin: 6, micHpf: 100 },
      opt: { spk: true, mic: true, zone: 'front', weight: 0.4 },
      heat: 'mic',
    };
  }

  function sanitize(s) {
    const d = defaultState();
    if (!s || typeof s !== 'object') return d;
    const out = {
      room: Object.assign({}, d.room, s.room || {}),
      adv: Object.assign({}, d.adv, s.adv || {}),
      opt: Object.assign({}, d.opt, s.opt || {}),
      heat: ['mic', 'spl', 'none'].includes(s.heat) ? s.heat : d.heat,
      speakers: Array.isArray(s.speakers) ? s.speakers.map((o, i) => makeSpeaker(o.name || '스피커 ' + (i + 1), 1, 1, pickNum(o, ['power', 'volume', 'sens', 'x', 'y', 'z', 'yaw', 'pitch'], { type: A.SPEAKER_TYPES[o.type] ? o.type : 'box' }))) : d.speakers,
      mics: Array.isArray(s.mics) ? s.mics.map((o, i) => makeMic(o.name || '마이크 ' + (i + 1), 1, 1, pickNum(o, ['x', 'y', 'z', 'yaw', 'pitch'], { pattern: A.MIC_PATTERNS[o.pattern] ? o.pattern : 'cardioid' }))) : d.mics,
    };
    for (const k of ['L', 'W', 'H', 'stage', 'people']) if (!Number.isFinite(+out.room[k])) out.room[k] = d.room[k];
    for (const k of ['wall', 'floor', 'ceil']) if (!A.MATERIALS[out.room[k]]) out.room[k] = d.room[k];
    if (!out.speakers.length) out.speakers = d.speakers;
    if (!out.mics.length) out.mics = d.mics;
    return out;
  }
  function pickNum(o, keys, base) {
    const r = Object.assign({}, base);
    for (const k of keys) if (Number.isFinite(+o[k])) r[k] = +o[k];
    return r;
  }

  function load() {
    try { const raw = localStorage.getItem(STORE_KEY); return raw ? sanitize(JSON.parse(raw)) : null; } catch (e) { return null; }
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    }, 300);
  }

  let state = load() || defaultState();
  let selected = state.mics[0] ? { kind: 'mic', id: state.mics[0].id } : null;
  let sim = null;
  let heat = null;
  let undoSnapshot = null;
  let optimizing = false;

  // ------------------------------------------------------------ 계산 컨텍스트
  let ctxKey = '', ctxFine = null, ctxHeat = null;
  function contexts() {
    const r = state.room;
    const key = [r.L, r.W, r.H, r.wall, r.floor, r.ceil, r.people].join('|');
    if (key !== ctxKey) {
      ctxKey = key;
      ctxFine = A.prepare(r, { perOct: 48 });
      ctxHeat = A.prepare(r, { perOct: 12 });
    }
    return { fine: ctxFine, heat: ctxHeat };
  }
  const simOpts = () => ({ lref: +state.adv.lref, micHpf: +state.adv.micHpf, reqMargin: +state.adv.reqMargin });

  function simulate() {
    const { fine } = contexts();
    const o = simOpts();
    const r = A.evaluate(fine, state.speakers, state.mics, o);
    r.contrib = A.pairContributions(fine, state.speakers, state.mics, r.iMax, o).sort((a, b) => b.db - a.db);
    r.peaks = A.peaks(r, 6, 3);
    const idx = (f) => { let b = 0; fine.freqs.forEach((x, i) => { if (Math.abs(Math.log(x / f)) < Math.abs(Math.log(fine.freqs[b] / f))) b = i; }); return b; };
    r.rt = (fine.T60[idx(500)] + fine.T60[idx(1000)]) / 2;
    r.cov = A.coverage(fine, state.speakers, A.audiencePoints(state.room, 8, 6, 1.2), o);
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
    const nSpk = state.speakers.length;
    const target = nSpk > 2 ? 34 : 46;
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
        if (mode === 'mic') {
          v = m0 ? A.evaluate(ctxH, state.speakers, [Object.assign({}, m0, { x, y })], o).maxDb : -60;
        } else {
          v = A.splAt(fine, state.speakers, { x, y, z: 1.2 }, o).spl;
        }
        vals[j * nx + i] = v;
        if (v > vmax) vmax = v;
      }
    }
    const off = document.createElement('canvas');
    off.width = nx; off.height = ny;
    const g = off.getContext('2d');
    const img = g.createImageData(nx, ny);
    const stops = mode === 'mic' ? loopStops() : SPL_STOPS;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = vals[j * nx + i];
        const c = ramp(stops, mode === 'mic' ? v : v - vmax);
        const p = ((ny - 1 - j) * nx + i) * 4; // y 위쪽이 +
        img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    heat = { mode, img: off, vmax, mic: m0 && m0.name };
    renderLegend();
  }

  function renderLegend() {
    const el = $('#legend');
    if (!heat) { el.innerHTML = ''; return; }
    if (heat.mode === 'mic') {
      const stops = loopStops();
      const lo = stops[0][0], hi = stops[stops.length - 1][0];
      const grad = stops.map(([v, c]) => `rgb(${c.map(Math.round).join(',')}) ${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`).join(',');
      el.innerHTML = `<span>안전 ${lo} dB</span><span class="bar" style="background:linear-gradient(90deg,${grad})"></span><span>${sgn(hi, 0)} dB 하울링</span>
        <span>· ${esc(heat.mic || '마이크')}의 높이·방향·지향성으로 각 지점에 마이크를 놓았을 때의 최대 루프 게인</span>`;
    } else {
      const grad = SPL_STOPS.map(([v, c]) => `rgb(${c.join(',')}) ${(((v + 15) / 15) * 100).toFixed(1)}%`).join(',');
      el.innerHTML = `<span>−15 dB</span><span class="bar" style="background:linear-gradient(90deg,${grad})"></span><span>최대 ${fmt(heat.vmax, 0)} dB SPL</span>
        <span>· 귀 높이 1.2 m, 2 kHz, 마이크 기준 입력 시 상대 음압</span>`;
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
  function arrowHead(g, x0, y0, x1, y1, size) {
    const a = Math.atan2(y1 - y0, x1 - x0);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x1 - size * Math.cos(a - 0.45), y1 - size * Math.sin(a - 0.45));
    g.lineTo(x1 - size * Math.cos(a + 0.45), y1 - size * Math.sin(a + 0.45));
    g.closePath();
    g.fill();
  }
  function label(g, text, x, y, color, align) {
    g.font = '600 12px system-ui, sans-serif';
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

  // ------------------------------------------------------------ 평면도
  let planGeom = null;
  const HANDLE_SPK = 44, HANDLE_MIC = 38;

  function drawPlan() {
    const cv = $('#plan');
    const { L, W, stage } = state.room;
    const wrapW = cv.parentElement.clientWidth;
    const pad = 36;
    let s = (wrapW - 2 * pad) / L;
    let h = W * s + 2 * pad;
    const maxH = Math.max(260, Math.min(620, window.innerHeight * 0.7));
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

    // 무대 영역
    const st = clamp(stage, 0, L);
    g.fillStyle = 'rgba(59,91,219,0.07)';
    g.fillRect(ox, oy, st * s, W * s);
    g.setLineDash([5, 5]);
    g.strokeStyle = 'rgba(59,91,219,0.5)';
    g.beginPath(); g.moveTo(ox + st * s, oy); g.lineTo(ox + st * s, oy + W * s); g.stroke();
    g.setLineDash([]);
    label(g, '무대', ox + 6, oy + W * s - 11, '#3b5bdb', 'left');
    label(g, '객석', ox + ((st + L) / 2) * s, oy + W * s - 11, '#6b7489');

    // 1 m 격자
    g.strokeStyle = 'rgba(30,40,60,0.07)';
    g.lineWidth = 1;
    for (let x = 1; x < L; x++) { g.beginPath(); g.moveTo(ox + x * s, oy); g.lineTo(ox + x * s, oy + W * s); g.stroke(); }
    for (let y = 1; y < W; y++) { g.beginPath(); g.moveTo(ox, oy + y * s); g.lineTo(ox + L * s, oy + y * s); g.stroke(); }
    g.fillStyle = '#8a92a6';
    g.font = '11px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'top';
    const stepX = s < 22 ? 2 : 1;
    for (let x = 0; x <= L + 1e-6; x += stepX) g.fillText(String(Math.round(x)), ox + x * s, oy + W * s + 5);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let y = 0; y <= W + 1e-6; y += stepX) g.fillText(String(Math.round(y)), ox - 6, oy + (W - y) * s);
    g.textAlign = 'right'; g.textBaseline = 'bottom';
    g.fillText(`${fmt(L)} m × ${fmt(W)} m × 높이 ${fmt(state.room.H)} m`, ox + L * s, oy - 6);

    g.strokeStyle = '#2f3747';
    g.lineWidth = 2;
    g.strokeRect(ox, oy, L * s, W * s);

    // 스피커→마이크 경로 (하울링 주파수 기여도)
    if (sim && sim.contrib.length) {
      const top = sim.contrib[0].db;
      for (const c of sim.contrib) {
        const sp = state.speakers[c.si], m = state.mics[c.mi];
        if (!sp || !m) continue;
        const rel = c.db - top;
        const t = clamp(1 + rel / 15, 0.08, 1);
        const [x0, y0] = P(sp.x, sp.y), [x1, y1] = P(m.x, m.y);
        g.strokeStyle = c.db > -(+state.adv.reqMargin) ? `rgba(224,49,49,${0.25 + 0.6 * t})` : `rgba(90,100,120,${0.15 + 0.35 * t})`;
        g.lineWidth = 1 + 2.5 * t;
        g.setLineDash([6, 5]);
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
      g.setLineDash([]);
    }

    // 스피커 커버리지 (방 안으로 클리핑)
    g.save();
    g.beginPath(); g.rect(ox, oy, L * s, W * s); g.clip();
    state.speakers.forEach((sp) => {
      const [cx, cy] = P(sp.x, sp.y);
      const half = A.speakerHalfAngle(sp.type, 2000) * Math.PI / 180;
      const pr = sp.pitch * Math.PI / 180;
      g.fillStyle = 'rgba(59,91,219,0.09)';
      g.strokeStyle = 'rgba(59,91,219,0.25)';
      g.lineWidth = 1;
      if (Math.abs(sp.pitch) > 60) {
        const dz = Math.max(0.3, sp.z - 1.2);
        const rad = Math.min(Math.max(L, W), dz * Math.tan(Math.min(half, 1.4))) * s;
        const d = A.dirVec(sp.yaw, sp.pitch);
        const tz = dz / Math.max(0.2, Math.abs(d[2]));
        const [ax, ay] = P(sp.x + d[0] * tz, sp.y + d[1] * tz);
        g.beginPath(); g.arc(ax, ay, rad, 0, Math.PI * 2); g.fill(); g.stroke();
      } else {
        const len = Math.max(1.2, 3.2 * Math.cos(pr)) * s;
        const yaw = -sp.yaw * Math.PI / 180;
        g.beginPath();
        g.moveTo(cx, cy);
        g.arc(cx, cy, len, yaw - half, yaw + half);
        g.closePath();
        g.fill(); g.stroke();
      }
    });
    g.restore();

    // 마이크 극성 패턴 + 화자
    state.mics.forEach((m, i) => {
      const [cx, cy] = P(m.x, m.y);
      const a = A.micA(m.pattern);
      const R = 30;
      const yaw = -m.yaw * Math.PI / 180;
      g.beginPath();
      for (let k = 0; k <= 96; k++) {
        const phi = (k / 96) * Math.PI * 2;
        const r = Math.abs(a + (1 - a) * Math.cos(phi)) * R;
        const px = cx + r * Math.cos(phi + yaw), py = cy + r * Math.sin(phi + yaw);
        if (k === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.closePath();
      g.fillStyle = 'rgba(194,37,92,0.10)';
      g.strokeStyle = 'rgba(194,37,92,0.55)';
      g.lineWidth = 1.2;
      g.fill(); g.stroke();
      // 화자 (마이크가 향하는 쪽 0.35 m)
      const d = A.dirVec(m.yaw, 0);
      const [tx, ty] = P(m.x + d[0] * 0.35, m.y + d[1] * 0.35);
      const hr = Math.max(6, 0.17 * s);
      g.fillStyle = '#adb5c7';
      g.beginPath(); g.arc(tx, ty, hr, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#868e9f';
      g.beginPath(); g.arc(tx + Math.cos(yaw + Math.PI) * hr * 0.75, ty + Math.sin(yaw + Math.PI) * hr * 0.75, hr * 0.35, 0, Math.PI * 2); g.fill();
    });

    // 스피커 본체
    state.speakers.forEach((sp, i) => {
      const [cx, cy] = P(sp.x, sp.y);
      const sel = isSel('spk', sp.id);
      const yaw = -sp.yaw * Math.PI / 180;
      g.save();
      g.translate(cx, cy);
      if (sp.type === 'ceiling') {
        const r = Math.max(8, 0.22 * s);
        g.fillStyle = SPK_COLOR;
        g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#fff'; g.lineWidth = 2;
        g.beginPath(); g.arc(0, 0, r * 0.5, 0, Math.PI * 2); g.stroke();
      } else {
        g.rotate(yaw);
        const dep = Math.max(11, 0.3 * s), wid = Math.max(16, 0.45 * s);
        g.fillStyle = SPK_COLOR;
        g.fillRect(-dep / 2, -wid / 2, dep, wid);
        g.fillStyle = '#9fb2ff';
        g.fillRect(dep / 2 - 3, -wid / 2, 3, wid);
      }
      if (sel) {
        g.strokeStyle = '#ffb703'; g.lineWidth = 3;
        g.beginPath(); g.arc(0, 0, Math.max(14, 0.35 * s), 0, Math.PI * 2); g.stroke();
      }
      g.restore();
      if (sp.type !== 'ceiling' && Math.abs(sp.pitch) < 85) {
        const hx = cx + Math.cos(yaw) * HANDLE_SPK, hy = cy + Math.sin(yaw) * HANDLE_SPK;
        g.strokeStyle = SPK_COLOR; g.fillStyle = SPK_COLOR; g.lineWidth = 2;
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(hx, hy); g.stroke();
        g.fillStyle = '#fff'; g.beginPath(); g.arc(hx, hy, 6, 0, Math.PI * 2); g.fill();
        g.strokeStyle = SPK_COLOR; g.stroke();
      }
      label(g, spkLabel(i), cx, cy - Math.max(18, 0.4 * s) - 4, SPK_COLOR);
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
      if (isSel('mic', m.id)) {
        g.strokeStyle = '#ffb703'; g.lineWidth = 3;
        g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.stroke();
      }
      label(g, micLabel(i), cx + (Math.cos(yaw) > 0 ? -16 : 16), cy - 16, MIC_COLOR);
    });
  }

  // ------------------------------------------------------------ 측면도
  let sideGeom = null;
  function drawSide() {
    const cv = $('#side');
    const { L, H, stage } = state.room;
    const wrapW = cv.parentElement.clientWidth;
    const pad = 28;
    let s = (wrapW - 2 * pad) / L;
    let h = H * s + 2 * pad;
    if (h < 190) h = 190;
    if (h > 300) { h = 300; }
    s = Math.min((wrapW - 2 * pad) / L, (h - 2 * pad) / H);
    const { g, w } = setupCanvas(cv, Math.round(h));
    const ox = (w - L * s) / 2, oy = (h - H * s) / 2;
    sideGeom = { s, ox, oy, L, H };
    const P = (x, z) => [ox + x * s, oy + (H - z) * s];

    g.fillStyle = '#f7f8fb'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff'; g.fillRect(ox, oy, L * s, H * s);
    g.fillStyle = 'rgba(59,91,219,0.07)'; g.fillRect(ox, oy, clamp(stage, 0, L) * s, H * s);
    // 귀 높이
    g.setLineDash([3, 4]); g.strokeStyle = 'rgba(30,40,60,0.25)'; g.lineWidth = 1;
    const [, ey] = P(0, 1.2);
    g.beginPath(); g.moveTo(ox, ey); g.lineTo(ox + L * s, ey); g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#8a92a6'; g.font = '11px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'bottom';
    g.fillText('귀 높이 1.2 m', ox + L * s - 4, ey - 2);
    // 청중 머리
    g.fillStyle = 'rgba(134,142,159,0.35)';
    for (let x = stage + 0.8; x < L - 0.3; x += 1.0) { const [px, py] = P(x, 1.2); g.beginPath(); g.arc(px, py, Math.max(3, 0.13 * s), 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = '#2f3747'; g.lineWidth = 2; g.strokeRect(ox, oy, L * s, H * s);
    g.fillStyle = '#8a92a6'; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let z = 0; z <= H + 1e-6; z += H > 6 ? 2 : 1) g.fillText(String(z), ox - 5, oy + (H - z) * s);
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText('← 무대', ox + 4, oy + H * s + 4);
    g.textAlign = 'right';
    g.fillText('객석 →', ox + L * s - 4, oy + H * s + 4);

    const handleOf = (o, len) => {
      const d = A.dirVec(o.yaw, o.pitch);
      let hx = d[0], hz = d[2];
      const n = Math.hypot(hx, hz);
      if (n < 0.2) { hx = 0; hz = d[2] >= 0 ? 1 : -1; } else { hx /= n; hz /= n; }
      const [cx, cy] = P(o.x, o.z);
      return [cx + hx * len, cy - hz * len];
    };
    state.speakers.forEach((sp, i) => {
      const [cx, cy] = P(sp.x, sp.z);
      const [hx, hy] = handleOf(sp, 34);
      g.strokeStyle = SPK_COLOR; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(hx, hy); g.stroke();
      g.save(); g.translate(cx, cy); g.rotate(Math.atan2(hy - cy, hx - cx));
      g.fillStyle = SPK_COLOR; g.fillRect(-7, -9, 14, 18);
      g.fillStyle = '#9fb2ff'; g.fillRect(4, -9, 3, 18);
      g.restore();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(hx, hy, 5.5, 0, Math.PI * 2); g.fill(); g.stroke();
      if (isSel('spk', sp.id)) { g.strokeStyle = '#ffb703'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 15, 0, Math.PI * 2); g.stroke(); }
      label(g, spkLabel(i), cx, cy - 20, SPK_COLOR);
    });
    state.mics.forEach((m, i) => {
      const [cx, cy] = P(m.x, m.z);
      const [hx, hy] = handleOf(m, 28);
      // 스탠드
      g.strokeStyle = '#adb5c7'; g.lineWidth = 2;
      const [, fy] = P(m.x, 0);
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, fy); g.stroke();
      g.strokeStyle = MIC_COLOR; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(hx, hy); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(hx, hy, 5.5, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = MIC_COLOR; g.beginPath(); g.arc(cx, cy, 7, 0, Math.PI * 2); g.fill();
      if (isSel('mic', m.id)) { g.strokeStyle = '#ffb703'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 13, 0, Math.PI * 2); g.stroke(); }
      label(g, micLabel(i), cx, cy - 18, MIC_COLOR);
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
    const req = +state.adv.reqMargin;
    let yMax = Math.max(10, Math.ceil((sim.maxDb + 4) / 5) * 5);
    let yMin = Math.min(-30, yMax - 45);
    const X = (f) => padL + (Math.log(f / fmin) / Math.log(fmax / fmin)) * (w - padL - padR);
    const Y = (d) => padT + ((yMax - d) / (yMax - yMin)) * (h - padT - padB);
    chartGeom = { X, Y, padL, padR, w, h, fmin, fmax };

    // 영역
    g.fillStyle = 'rgba(224,49,49,0.08)'; g.fillRect(padL, Y(yMax), w - padL - padR, Y(0) - Y(yMax));
    g.fillStyle = 'rgba(217,138,11,0.10)'; g.fillRect(padL, Y(0), w - padL - padR, Y(-req) - Y(0));
    // 격자
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
    // 기준선
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
    // 잔향 성분
    g.strokeStyle = 'rgba(120,130,150,0.7)'; g.lineWidth = 1.2; g.setLineDash([4, 3]);
    g.beginPath();
    for (let i = 0; i < freqs.length; i++) { const x = X(freqs[i]), y = Y(lateDb[i]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke(); g.setLineDash([]);
    // 0 dB 초과 영역 채움
    g.fillStyle = 'rgba(224,49,49,0.35)';
    g.beginPath(); g.moveTo(X(freqs[0]), Y(0));
    for (let i = 0; i < freqs.length; i++) g.lineTo(X(freqs[i]), Y(Math.max(0, db[i])));
    g.lineTo(X(freqs[freqs.length - 1]), Y(0)); g.closePath(); g.fill();
    // 전체
    g.strokeStyle = '#1d2433'; g.lineWidth = 1.8;
    g.beginPath();
    for (let i = 0; i < freqs.length; i++) { const x = X(freqs[i]), y = Y(db[i]); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
    g.restore();

    // 범례
    g.font = '11px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillStyle = '#1d2433'; g.fillText('━ 전체 루프 게인', padL + 6, padT + 2);
    g.fillStyle = '#7c8496'; g.fillText('╌ 잔향 성분', padL + 6, padT + 16);

    // 최대점
    const mx = X(sim.fMax), my = Y(sim.maxDb);
    const col = sim.maxDb >= 0 ? '#e03131' : sim.maxDb >= -req ? '#d98a0b' : '#1f9d55';
    g.fillStyle = col; g.beginPath(); g.arc(mx, my, 5, 0, Math.PI * 2); g.fill();
    const txt = `${fmtHz(sim.fMax)}  ${sgn(sim.maxDb)} dB`;
    g.font = '600 12px system-ui, sans-serif';
    const tw = g.measureText(txt).width;
    const tx = clamp(mx - tw / 2, padL + 2, w - padR - tw - 2);
    label(g, txt, tx, Math.max(padT + 8, my - 14), col, 'left');

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
  function safeVolume(v, marginDb, targetMargin) {
    return clamp(v * Math.pow(10, (marginDb - targetMargin) / 20), 0, 100);
  }

  function renderStatus() {
    if (!sim) return;
    const req = +state.adv.reqMargin;
    const b = $('#badge');
    b.className = 'badge ' + (sim.maxDb >= 0 ? 'howl' : sim.maxDb >= -req ? 'risk' : 'safe');
    b.innerHTML = sim.maxDb >= 0
      ? `하울링 발생<small>루프 게인이 0 dB를 넘습니다</small>`
      : sim.maxDb >= -req
        ? `하울링 위험<small>안정 여유 부족 (권장 ≥ ${req} dB)</small>`
        : `안정<small>하울링 여유 충분</small>`;
    const mini = $('#miniStatus');
    mini.className = 'mini-status ' + (sim.maxDb >= 0 ? 'howl' : sim.maxDb >= -req ? 'risk' : 'safe');
    mini.innerHTML = `<b>${sim.maxDb >= 0 ? '하울링 발생' : sim.maxDb >= -req ? '하울링 위험' : '안정'}</b><span>여유 ${fmt(sim.margin)} dB · ${fmtHz(sim.fMax)}</span>`;
    $('#mLoop').textContent = sgn(sim.maxDb) + ' dB';
    $('#mMargin').textContent = fmt(sim.margin) + ' dB';
    $('#mFreq').textContent = fmtHz(sim.fMax);
    const vols = state.speakers.map((s) => s.volume);
    const same = vols.every((v) => v === vols[0]);
    const onset = vols.map((v) => v * Math.pow(10, sim.margin / 20));
    $('#mOnset').textContent = same
      ? onset[0] > 100 ? '100%에서도 없음' : Math.floor(onset[0]) + '%'
      : (sim.margin >= 0 ? '현재 +' : '현재 ') + fmt(sim.margin) + ' dB';
    $('#mRt').textContent = fmt(sim.rt, 2) + ' 초';
    $('#mSpl').textContent = fmt(sim.cov.meanSpl, 0) + ' dB';
    $('#mSpl').parentElement.title = `마이크에 ${state.adv.lref} dB SPL이 들어올 때 객석(귀 높이) 평균 음압. 직접음/잔향음 비 ${sgn(sim.cov.meanDR)} dB, 편차 ±${fmt(sim.cov.stdSpl)} dB`;
    const V = state.room.L * state.room.W * state.room.H;
    $('#roomInfo').textContent = `체적 ${fmt(V, 0)} m³ · RT60 ≈ ${fmt(sim.rt, 2)} 초`;
  }

  function renderAdvice() {
    if (!sim) return;
    const req = +state.adv.reqMargin;
    const items = [];
    const add = (cls, html) => items.push(`<li class="${cls}">${html}</li>`);
    if (sim.maxDb >= 0) add('bad', `<b>${fmtHz(sim.fMax)}</b> 부근에서 하울링이 발생합니다 (루프 게인 <b>${sgn(sim.maxDb)} dB</b>).`);
    else if (sim.maxDb >= -req) add('warn', `하울링 직전입니다. <b>${fmtHz(sim.fMax)}</b> 부근 여유가 <b>${fmt(sim.margin)} dB</b>로 권장값(${req} dB)보다 작아 링잉·울림이 생길 수 있습니다.`);
    else add('good', `안정 여유 <b>${fmt(sim.margin)} dB</b>로 하울링 위험이 낮습니다.`);

    const top = sim.contrib[0];
    if (top && sim.margin < req + 4) {
      const sp = state.speakers[top.si], m = state.mics[top.mi];
      const sn = `${spkLabel(top.si)}(${esc(sp.name)})`, mn = `${micLabel(top.mi)}(${esc(m.name)})`;
      add('info', `주 원인 경로: <b>${sn} → ${mn}</b> · 거리 ${fmt(top.dist)} m`);
      const a = A.micA(m.pattern);
      const nullAng = a >= 1 ? null : a <= 0.5 ? (a === 0.5 ? 180 : Math.round(Math.acos(-a / (1 - a)) * 180 / Math.PI)) : null;
      if (m.pattern !== 'omni' && top.micAngle < 90) {
        add('bad', `${sn}가 ${mn}의 <b>앞쪽 수음 범위</b>(마이크 축에서 ${fmt(top.micAngle, 0)}°)에 있습니다. 마이크 뒤쪽 감도 최저점(약 ${nullAng}°)이 스피커를 향하도록 마이크를 돌리거나 스피커를 마이크보다 앞(객석 쪽)으로 옮기세요.`);
      } else if (m.pattern !== 'omni' && nullAng && Math.abs(top.micAngle - nullAng) > 45) {
        add('warn', `${sn}가 ${mn}의 감도 최저점(${nullAng}°)에서 벗어나 있습니다 (현재 ${fmt(top.micAngle, 0)}°).`);
      }
      const half = A.speakerHalfAngle(sp.type, 2000);
      if (top.spkAngle < half) add('bad', `${sn}가 마이크를 <b>직접 향하고</b> 있습니다 (스피커 축에서 ${fmt(top.spkAngle, 0)}°, 커버리지 ±${fmt(half, 0)}°). 스피커를 객석 쪽으로 돌리거나 마이크를 커버리지 밖으로 옮기세요.`);
      if (top.dist < 2.5) add('warn', `${sn}와 ${mn}의 거리가 ${fmt(top.dist)} m로 가깝습니다. 거리를 2배로 늘리면 직접음 경로가 약 6 dB 줄어듭니다.`);
    }
    const i = sim.iMax;
    if (sim.lateDb[i] > sim.earlyDb[i] && sim.margin < req + 4) {
      add('info', `하울링 주파수에서 <b>잔향음이 지배적</b>입니다(잔향 ${sgn(sim.lateDb[i])} dB vs 직접·초기 반사 ${sgn(sim.earlyDb[i])} dB). 배치 변경보다 흡음(카펫·커튼·흡음 패널), 지향성 마이크, 볼륨 조정이 더 효과적입니다.`);
    }
    if (state.mics.some((m) => m.pattern === 'omni')) add('warn', '무지향 마이크는 하울링에 취약합니다. 카디오이드 계열로 바꾸면 잔향 수음이 약 4.8 dB 줄어듭니다.');
    if (sim.rt > 1.2) add('warn', `잔향시간이 ${fmt(sim.rt, 2)}초로 깁니다. 벽·천장 흡음재나 커튼을 추가하면 하울링 여유와 명료도가 함께 좋아집니다.`);
    if (state.mics.length > 1) add('info', `마이크 ${state.mics.length}개가 동시에 열려 있으면 여유가 약 ${fmt(10 * Math.log10(state.mics.length))} dB 줄어듭니다. 쓰지 않는 마이크는 뮤트하세요.`);
    if (sim.margin < req + 3 && sim.peaks.length) {
      add('info', `EQ 링아웃: <b>${sim.peaks.map((p) => fmtHz(p.f)).join(', ')}</b> 부근을 좁은 대역(Q≈8)으로 3–6 dB 컷하면 여유를 더 확보할 수 있습니다.`);
    }
    if (sim.margin < req) {
      const list = state.speakers.map((s, k) => `${spkLabel(k)} ${Math.floor(safeVolume(s.volume, sim.margin, req))}%`).join(', ');
      add('warn', `배치를 그대로 두려면 모든 스피커 볼륨을 ${fmt(req - sim.margin)} dB 낮추세요 → ${list} <button class="icon" data-action="safe-vol">권장 볼륨 적용</button>`);
    }
    $('#advice').innerHTML = items.join('');
  }

  // ------------------------------------------------------------ 사이드바 렌더링
  function opt(list, val) {
    return Object.entries(list).map(([k, v]) => `<option value="${k}"${k === val ? ' selected' : ''}>${esc(v.name)}</option>`).join('');
  }
  function numField(labelText, field, v, step, extra) {
    return `<label>${labelText}<input type="number" step="${step}" data-field="${field}" value="${v}" ${extra || ''}></label>`;
  }

  function renderLists() {
    $('#spkList').innerHTML = state.speakers.map((s, i) => `
      <div class="obj spk${isSel('spk', s.id) ? ' selected' : ''}" data-kind="spk" data-id="${s.id}">
        <div class="obj-head"><span class="tag">${spkLabel(i)}</span><input class="name" data-field="name" value="${esc(s.name)}" aria-label="이름">
          <button class="icon" data-action="del" title="삭제">✕</button></div>
        <label class="span3">타입<select data-field="type">${opt(A.SPEAKER_TYPES, s.type)}</select></label>
        <div class="grid3">
          ${numField('정격 출력 (W)', 'power', s.power, 10, 'min="1" max="10000"')}
          ${numField('감도 (dB/1W/1m)', 'sens', s.sens, 1, 'min="70" max="120"')}
          <label>최대 음압<input type="text" data-out="maxspl" disabled></label>
          ${numField('X 길이 (m)', 'x', s.x, 0.1)}
          ${numField('Y 폭 (m)', 'y', s.y, 0.1)}
          ${numField('Z 높이 (m)', 'z', s.z, 0.1)}
          ${numField('방향 (°)', 'yaw', s.yaw, 5)}
          ${numField('기울기 (°)', 'pitch', s.pitch, 5, 'min="-90" max="90"')}
          <label>커버리지<input type="text" data-out="cov" disabled></label>
        </div>
        <label>볼륨
          <div class="vol-row"><input type="range" min="0" max="100" step="1" data-field="volume" value="${s.volume}"><output data-out="vol"></output></div>
        </label>
        <div class="safe-vol" data-out="safe"></div>
      </div>`).join('');
    $('#micList').innerHTML = state.mics.map((m, i) => `
      <div class="obj mic${isSel('mic', m.id) ? ' selected' : ''}" data-kind="mic" data-id="${m.id}">
        <div class="obj-head"><span class="tag">${micLabel(i)}</span><input class="name" data-field="name" value="${esc(m.name)}" aria-label="이름">
          <button class="icon" data-action="del" title="삭제">✕</button></div>
        <label>지향성<select data-field="pattern">${opt(A.MIC_PATTERNS, m.pattern)}</select></label>
        <div class="grid3">
          ${numField('X 길이 (m)', 'x', m.x, 0.1)}
          ${numField('Y 폭 (m)', 'y', m.y, 0.1)}
          ${numField('Z 높이 (m)', 'z', m.z, 0.1)}
          ${numField('방향 (°)', 'yaw', m.yaw, 5)}
          ${numField('기울기 (°)', 'pitch', m.pitch, 5, 'min="-90" max="90"')}
        </div>
      </div>`).join('');
    $('#spkCount').textContent = `(${state.speakers.length})`;
    $('#micCount').textContent = `(${state.mics.length})`;
    syncInputs();
  }

  const DECIMALS = { x: 2, y: 2, z: 2, yaw: 0, pitch: 0, power: 0, sens: 0, volume: 0 };
  function syncInputs() {
    const active = document.activeElement;
    document.querySelectorAll('.obj').forEach((card) => {
      const list = card.dataset.kind === 'spk' ? state.speakers : state.mics;
      const o = list.find((x) => x.id === card.dataset.id);
      if (!o) return;
      card.querySelectorAll('[data-field]').forEach((inp) => {
        if (inp === active) return;
        const f = inp.dataset.field;
        if (f in DECIMALS) {
          const v = +(+o[f]).toFixed(DECIMALS[f]);
          if (+inp.value !== v) inp.value = v;
        }
      });
      if (card.dataset.kind === 'spk') {
        const vdb = o.volume > 0 ? 20 * Math.log10(o.volume / 100) : -Infinity;
        card.querySelector('[data-out="vol"]').innerHTML = `${Math.round(o.volume)}% <small>(${Number.isFinite(vdb) ? fmt(vdb) + ' dB' : '음소거'})</small>`;
        const maxspl = o.sens + 10 * Math.log10(Math.max(1e-6, o.power));
        card.querySelector('[data-out="maxspl"]').value = `${fmt(maxspl, 0)} dB@1m`;
        card.querySelector('[data-out="cov"]').value = `±${fmt(A.speakerHalfAngle(o.type, 2000), 0)}°`;
        const safe = card.querySelector('[data-out="safe"]');
        if (sim && o.volume > 0) {
          const on = o.volume * Math.pow(10, sim.margin / 20);
          const rec = safeVolume(o.volume, sim.margin, +state.adv.reqMargin);
          safe.innerHTML = `하울링 시작 ≈ <b>${on > 100 ? '100% 초과' : Math.floor(on) + '%'}</b> · 권장 최대 ≈ <b>${rec >= 100 ? '100%' : Math.floor(rec) + '%'}</b>`;
        } else safe.textContent = '';
      }
      card.classList.toggle('selected', isSel(card.dataset.kind, o.id));
    });
  }

  function renderRoomInputs() {
    document.querySelectorAll('[data-room]').forEach((el) => {
      const k = el.dataset.room;
      if (el.tagName === 'SELECT') {
        if (!el.options.length) el.innerHTML = opt(A.MATERIALS, state.room[k]);
        el.value = state.room[k];
      } else el.value = state.room[k];
    });
    document.querySelectorAll('[data-adv]').forEach((el) => { el.value = state.adv[el.dataset.adv]; });
    $('#heatMode').value = state.heat;
    $('#optSpk').checked = state.opt.spk;
    $('#optMic').checked = state.opt.mic;
    $('#optZone').value = state.opt.zone;
    $('#optWeight').value = state.opt.weight;
  }

  function clampObjects() {
    const { L, W, H } = state.room;
    for (const o of [...state.speakers, ...state.mics]) {
      o.x = clamp(o.x, 0.05, L - 0.05);
      o.y = clamp(o.y, 0.05, W - 0.05);
      o.z = clamp(o.z, 0.05, H - 0.05);
    }
  }

  // ------------------------------------------------------------ 이벤트: 사이드바
  function onListInput(e) {
    const inp = e.target.closest('[data-field]');
    if (!inp) return;
    const card = inp.closest('.obj');
    const list = card.dataset.kind === 'spk' ? state.speakers : state.mics;
    const o = list.find((x) => x.id === card.dataset.id);
    if (!o) return;
    const f = inp.dataset.field;
    if (f === 'name' || f === 'type' || f === 'pattern') {
      o[f] = inp.value;
      if (f === 'type' && inp.value === 'ceiling') { o.z = Math.round((state.room.H - 0.05) * 100) / 100; o.pitch = -90; }
    } else {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) return;
      if (f === 'yaw') o.yaw = normYaw(v);
      else if (f === 'pitch') o.pitch = clamp(v, -90, 90);
      else if (f === 'volume') o.volume = clamp(v, 0, 100);
      else if (f === 'power') o.power = Math.max(0.1, v);
      else o[f] = v;
      clampObjects();
    }
    selected = { kind: card.dataset.kind, id: o.id };
    requestUpdate();
  }

  function onListClick(e) {
    const btn = e.target.closest('[data-action="del"]');
    const card = e.target.closest('.obj');
    if (!card) return;
    if (btn) {
      const kind = card.dataset.kind;
      const list = kind === 'spk' ? state.speakers : state.mics;
      if (list.length <= 1) { toast(kind === 'spk' ? '스피커는 최소 1개가 필요합니다.' : '마이크는 최소 1개가 필요합니다.'); return; }
      const idx = list.findIndex((x) => x.id === card.dataset.id);
      list.splice(idx, 1);
      renderLists();
      requestUpdate();
      return;
    }
    const prev = selected && selected.id;
    selected = { kind: card.dataset.kind, id: card.dataset.id };
    if (prev !== selected.id) {
      syncInputs();
      drawAll();
      if (state.heat === 'mic' && selected.kind === 'mic') scheduleHeat();
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
    const hits = cands.filter((c) => c.d <= c.r).sort((a, b) => (a.part === b.part ? a.d - b.d : a.part === 'rot' ? -1 : 1));
    return hits[0] || null;
  }

  function sideHit(px, py) {
    const g = sideGeom;
    if (!g) return null;
    const P = (x, z) => [g.ox + x * g.s, g.oy + (g.H - z) * g.s];
    const cands = [];
    const handle = (o, len) => {
      const d = A.dirVec(o.yaw, o.pitch);
      let hx = d[0], hz = d[2];
      const n = Math.hypot(hx, hz);
      if (n < 0.2) { hx = 0; hz = d[2] >= 0 ? 1 : -1; } else { hx /= n; hz /= n; }
      const [cx, cy] = P(o.x, o.z);
      return [cx + hx * len, cy - hz * len];
    };
    state.speakers.forEach((o) => {
      const [cx, cy] = P(o.x, o.z);
      const [hx, hy] = handle(o, 34);
      if (o.type !== 'ceiling') cands.push({ kind: 'spk', o, part: 'pitch', d: Math.hypot(px - hx, py - hy), r: 11 });
      cands.push({ kind: 'spk', o, part: 'body', d: Math.hypot(px - cx, py - cy), r: 15 });
    });
    state.mics.forEach((o) => {
      const [cx, cy] = P(o.x, o.z);
      const [hx, hy] = handle(o, 28);
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
      if (prevSel !== selected.id) { syncInputs(); drawAll(); }
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
        const [cx, cy] = [g.ox + o.x * g.s, g.oy + (g.W - o.y) * g.s];
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
        const [cx, cy] = [g.ox + o.x * g.s, g.oy + (g.H - o.z) * g.s];
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
        if (moved) requestUpdate();
        else if (state.heat === 'mic') scheduleHeat();
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

  // ------------------------------------------------------------ 최적화
  function runOptimize() {
    if (optimizing) return;
    const o = state.opt;
    if (!o.spk && !o.mic) { $('#optResult').innerHTML = '<span class="down">최적화할 대상을 하나 이상 선택하세요.</span>'; return; }
    const cfg = {
      speakers: state.speakers.map((s) => Object.assign({}, s, { yaw: normYaw(s.yaw) })),
      mics: state.mics.map((m) => Object.assign({}, m, { yaw: ((m.yaw % 360) + 360) % 360 })),
    };
    const optimizer = A.createOptimizer(state.room, cfg, {
      optSpk: o.spk, optMic: o.mic, zone: o.zone, weight: +o.weight,
      reqMargin: +state.adv.reqMargin, lref: +state.adv.lref, micHpf: +state.adv.micHpf,
      seed: (Date.now() & 0xffff) + 1,
    });
    optimizing = true;
    const btn = $('#btnOptimize');
    btn.disabled = true;
    btn.textContent = '최적 배치 계산 중…';
    const bar = $('#optProgress');
    bar.hidden = false;
    $('#optResult').innerHTML = '<span class="muted">수천 가지 배치를 시뮬레이션하고 있습니다…</span>';
    const tick = () => {
      optimizer.step(35);
      bar.firstElementChild.style.width = (optimizer.progress * 100).toFixed(1) + '%';
      if (!optimizer.done) setTimeout(tick, 0);
      else finishOptimize(optimizer.result);
    };
    setTimeout(tick, 30);
  }

  function finishOptimize(res) {
    optimizing = false;
    const btn = $('#btnOptimize');
    btn.disabled = false;
    btn.textContent = '자동 최적 배치 실행';
    $('#optProgress').hidden = true;
    const req = +state.adv.reqMargin;
    undoSnapshot = JSON.parse(JSON.stringify({ speakers: state.speakers, mics: state.mics }));
    const r2 = (v) => Math.round(v * 100) / 100;
    if (!res.keptCurrent) {
      res.config.speakers.forEach((s, i) => Object.assign(state.speakers[i], { x: r2(s.x), y: r2(s.y), z: r2(s.z), yaw: normYaw(Math.round(s.yaw)), pitch: Math.round(s.pitch) }));
      res.config.mics.forEach((m, i) => Object.assign(state.mics[i], { x: r2(m.x), y: r2(m.y), z: r2(m.z), yaw: normYaw(Math.round(m.yaw)), pitch: Math.round(m.pitch) }));
    }
    $('#btnUndo').hidden = res.keptCurrent;
    simulate();
    const after = sim.margin;
    const before = res.before.margin;
    const delta = after - before;
    const rows = [
      ['안정 여유', `${fmt(before)} dB`, `${fmt(after)} dB`, delta],
      ['객석 음압 편차', `±${fmt(res.before.coverage.stdSpl)} dB`, `±${fmt(sim.cov.stdSpl)} dB`, res.before.coverage.stdSpl - sim.cov.stdSpl],
      ['직접음/잔향음 비', `${sgn(res.before.coverage.meanDR)} dB`, `${sgn(sim.cov.meanDR)} dB`, sim.cov.meanDR - res.before.coverage.meanDR],
    ];
    let html = res.keptCurrent
      ? '<b>현재 배치가 이미 탐색한 후보 중 가장 좋습니다.</b>'
      : `<b>최적 배치를 적용했습니다.</b> (${res.evals.toLocaleString()}개 배치 시뮬레이션)`;
    html += `<table><tr><th>지표</th><th>이전</th><th>최적화 후</th><th></th></tr>${rows.map(([n, a, b, d]) => `<tr><td>${n}</td><td>${a}</td><td>${b}</td><td class="${d >= 0.05 ? 'up' : d <= -0.05 ? 'down' : ''}">${d >= 0.05 ? '▲' : d <= -0.05 ? '▼' : '–'}</td></tr>`).join('')}</table>`;
    if (after < req) {
      const list = state.speakers.map((s, k) => `${spkLabel(k)} ${Math.floor(safeVolume(s.volume, after, req))}%`).join(', ');
      html += `<p class="down">배치만으로는 필요 여유(${req} dB)를 확보할 수 없습니다. 볼륨을 ${fmt(req - after)} dB 낮추세요 → ${list} <button class="icon" data-action="safe-vol">권장 볼륨 적용</button></p>`;
    } else {
      html += `<p class="up">필요 여유 ${req} dB를 확보했습니다.</p>`;
    }
    $('#optResult').innerHTML = html;
    requestUpdate();
  }

  function applySafeVolume() {
    if (!sim) return;
    const req = +state.adv.reqMargin;
    const m = sim.margin;
    state.speakers.forEach((s) => { s.volume = Math.floor(safeVolume(s.volume, m, req)); });
    requestUpdate();
  }

  // ------------------------------------------------------------ 초기화 및 바인딩
  function bind() {
    $('#spkList').addEventListener('input', onListInput);
    $('#micList').addEventListener('input', onListInput);
    $('#spkList').addEventListener('click', onListClick);
    $('#micList').addEventListener('click', onListClick);
    document.querySelectorAll('[data-room]').forEach((el) => el.addEventListener('input', () => {
      const k = el.dataset.room;
      if (el.tagName === 'SELECT') state.room[k] = el.value;
      else {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) return;
        const lim = { L: [2, 60], W: [2, 60], H: [2, 20], stage: [0.5, 30], people: [0, 2000] }[k];
        state.room[k] = clamp(v, lim[0], lim[1]);
      }
      state.room.stage = Math.min(state.room.stage, state.room.L - 0.5);
      state.speakers.forEach((s) => { if (s.type === 'ceiling') s.z = Math.round((state.room.H - 0.05) * 100) / 100; });
      clampObjects();
      requestUpdate();
    }));
    document.querySelectorAll('[data-adv]').forEach((el) => el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) return;
      state.adv[el.dataset.adv] = v;
      requestUpdate();
    }));
    $('#heatMode').addEventListener('change', (e) => { state.heat = e.target.value; computeHeat(); drawPlan(); save(); });
    $('#optSpk').addEventListener('change', (e) => { state.opt.spk = e.target.checked; save(); });
    $('#optMic').addEventListener('change', (e) => { state.opt.mic = e.target.checked; save(); });
    $('#optZone').addEventListener('change', (e) => { state.opt.zone = e.target.value; save(); });
    $('#optWeight').addEventListener('input', (e) => { state.opt.weight = +e.target.value; save(); });
    $('#btnOptimize').addEventListener('click', runOptimize);
    $('#btnUndo').addEventListener('click', () => {
      if (!undoSnapshot) return;
      state.speakers = undoSnapshot.speakers;
      state.mics = undoSnapshot.mics;
      undoSnapshot = null;
      $('#btnUndo').hidden = true;
      $('#optResult').innerHTML = '<span class="muted">이전 배치로 되돌렸습니다.</span>';
      renderLists();
      requestUpdate();
    });
    document.addEventListener('click', (e) => { if (e.target.closest('[data-action="safe-vol"]')) applySafeVolume(); });
    $('#btnAddSpk').addEventListener('click', () => {
      const n = state.speakers.length;
      const { L, W, stage } = state.room;
      const s = makeSpeaker('스피커 ' + (n + 1), clamp(stage + 0.5, 0.3, L - 0.3), clamp(W / 2 + (n % 2 ? 1 : -1) * W * 0.3, 0.3, W - 0.3));
      s.z = Math.min(2.2, state.room.H - 0.2);
      state.speakers.push(s);
      selected = { kind: 'spk', id: s.id };
      renderLists();
      requestUpdate();
    });
    $('#btnAddMic').addEventListener('click', () => {
      const n = state.mics.length;
      const { W, stage } = state.room;
      const m = makeMic('마이크 ' + (n + 1), clamp(stage * 0.6, 0.3, 30), clamp(W / 2 + (n % 2 ? 1 : -1) * 1.2 * Math.ceil(n / 2), 0.3, W - 0.3));
      state.mics.push(m);
      selected = { kind: 'mic', id: m.id };
      renderLists();
      requestUpdate();
    });
    let resetArmed = null;
    $('#btnReset').addEventListener('click', (e) => {
      // 두 번 눌러 확인 (브라우저 확인창 없이)
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
      $('#btnUndo').hidden = true;
      $('#optResult').innerHTML = '';
      renderRoomInputs();
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
        renderRoomInputs();
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
  renderRoomInputs();
  renderLists();
  requestUpdate();

  // 디버그/테스트용
  window.HowlSim = { get state() { return state; }, get sim() { return sim; }, runOptimize, requestUpdate };
})();
