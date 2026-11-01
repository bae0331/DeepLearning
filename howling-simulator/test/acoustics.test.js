// 실행: node --test howling-simulator/test/acoustics.test.js
const test = require('node:test');
const assert = require('node:assert');
const A = require('../acoustics.js');

const room = { L: 6, W: 4.5, H: 2.7, surfaces: { A: 'gypsum', B: 'gypsum', C: 'gypsum', D: 'gypsum', floor: 'carpet', ceil: 'acoustictile' }, patches: [], people: 6 };
const OPTS = { lref: 100, micHpf: 100, taper: 'audio' };
const mic = (o) => Object.assign({ model: 'beta58a', x: 2, y: 2.25, z: 1.55, yaw: 180, pitch: 0 }, o);
const pa = (o) => Object.assign({ type: 'box', power: 300, sens: 97, volume: 45, routed: true, x: 0.2, y: 0.6, z: 2, yaw: 20, pitch: -15 }, o);
const amp = (o) => Object.assign({ type: 'gtrcombo', power: 40, sens: 90, volume: 60, routed: false, x: 2.8, y: 4.3, z: 0.3, yaw: -90, pitch: 10 }, o);
const people = [{ name: '보컬', vocal: true, z: 1.6 }, { name: '기타1', x: 3, y: 1, z: 1.5 }, { name: '기타2', x: 2.8, y: 3.5, z: 1.5 }, { name: '베이스', x: 4.8, y: 3.2, z: 1.5 }, { name: '드럼', x: 5, y: 1.5, z: 1.2 }, { name: '멤버6', x: 4, y: 0.9, z: 1.5 }];
const idxOf = (ctx, f) => ctx.freqIndex(f);

test('흡음이 많을수록 잔향시간이 짧아지고, 흡음재 패치도 반영된다', () => {
  const hard = A.prepare({ ...room, surfaces: { A: 'concrete', B: 'concrete', C: 'concrete', D: 'concrete', floor: 'tile', ceil: 'concrete' }, people: 0 });
  const soft = A.prepare(room);
  const i = idxOf(soft, 1000);
  assert.ok(hard.T60[i] > 2 * soft.T60[i], `hard ${hard.T60[i]} vs soft ${soft.T60[i]}`);
  const treated = A.prepare({ ...room, patches: [{ surface: 'A', type: 'panel50', u: 2.25, v: 1.5, w: 2.4, h: 1.2 }] });
  assert.ok(treated.T60[i] < soft.T60[i]);
  assert.ok(Math.abs(treated.absorption[i] - soft.absorption[i] - 2.88 * (0.99 - 0.04)) < 0.05);
});

test('볼륨 노브: 오디오 테이퍼(50%≈−21 dB)와 선형(50%=−6 dB), 역변환 일치', () => {
  assert.ok(Math.abs(A.volumeDb(50, 'audio') + 20.8) < 0.1);
  assert.ok(Math.abs(A.volumeDb(50, 'linear') + 6.02) < 0.01);
  assert.strictEqual(A.volumeDb(100, 'audio'), 0);
  for (const t of ['audio', 'linear']) for (const v of [20, 45, 80]) {
    const v2 = A.volumeForDelta(v, -6, t);
    assert.ok(Math.abs(A.volumeDb(v2, t) - (A.volumeDb(v, t) - 6)) < 1e-6);
  }
});

test('출력 2배 → +3 dB, 볼륨 게인 변화가 루프 게인에 그대로 반영된다', () => {
  const ctx = A.prepare(room);
  const base = A.evaluate(ctx, [pa({ volume: 40 })], [mic()], OPTS);
  const pow2 = A.evaluate(ctx, [pa({ volume: 40, power: 600 })], [mic()], OPTS);
  const vol = A.evaluate(ctx, [pa({ volume: 60 })], [mic()], OPTS);
  const dv = A.volumeDb(60) - A.volumeDb(40);
  for (let i = 0; i < ctx.nf; i += 17) {
    assert.ok(Math.abs(pow2.db[i] - base.db[i] - 3.0103) < 1e-6);
    assert.ok(Math.abs(vol.db[i] - base.db[i] - dv) < 1e-6);
  }
});

test('무반사 방에서는 직접음 역제곱 법칙과 일치한다', () => {
  A.MATERIALS.__anechoic = { name: 'test', a: [0.99, 0.99, 0.99, 0.99, 0.99, 0.99] };
  const an = '__anechoic';
  const ctx = A.prepare({ L: 30, W: 30, H: 30, surfaces: { A: an, B: an, C: an, D: an, floor: an, ceil: an }, people: 0 });
  const s = pa({ x: 10, y: 15, z: 15, yaw: 0, pitch: 0, volume: 100 });
  const m = { model: 'omni', x: 14, y: 15, z: 15, yaw: 180, pitch: 0 };
  const r = A.evaluate(ctx, [s], [m], { lref: 100, micHpf: 0 });
  const i = idxOf(ctx, 1000);
  const expected = 97 + 10 * Math.log10(300) - 100 - 20 * Math.log10(4);
  assert.ok(Math.abs(r.earlyDb[i] - expected) < 0.5, `early ${r.earlyDb[i]} vs ${expected}`);
  delete A.MATERIALS.__anechoic;
});

test('보컬 신호를 출력하지 않는 악기 앰프는 하울링 루프에 들어가지 않고 블리드만 만든다', () => {
  const ctx = A.prepare(room);
  const onlyPa = A.evaluate(ctx, [pa()], [mic()], OPTS);
  const withAmp = A.evaluate(ctx, [pa(), amp({ volume: 100 })], [mic()], OPTS);
  assert.strictEqual(withAmp.maxDb, onlyPa.maxDb);
  const noLoop = A.evaluate(ctx, [amp()], [mic()], OPTS);
  assert.strictEqual(noLoop.hasLoop, false);
  const b1 = A.bleed(ctx, [amp({ volume: 40 })], [mic()], OPTS).db;
  const b2 = A.bleed(ctx, [amp({ volume: 80 })], [mic()], OPTS).db;
  assert.ok(b2 > b1);
  assert.ok(!Number.isFinite(A.bleed(ctx, [pa()], [mic()], OPTS).db));
});

test('슈퍼카디오이드(Beta 58A): 감도 최저점 ≈126°, 마이크 정면이 스피커를 향하면 루프 게인 증가', () => {
  assert.ok(Math.abs(A.micNullAngle('supercardioid') - 126) < 1.5);
  assert.strictEqual(A.micPattern({ model: 'beta58a' }), 'supercardioid');
  const ctx = A.prepare(room);
  const s = [pa({ x: 0.2, y: 2.25, yaw: 0, pitch: 0, z: 1.6 })];
  const facing = A.evaluate(ctx, s, [mic({ yaw: 180 })], OPTS);
  const away = A.evaluate(ctx, s, [mic({ yaw: 0 })], OPTS);
  assert.ok(facing.maxDb - away.maxDb > 3, `facing ${facing.maxDb} away ${away.maxDb}`);
});

test('반사 지점의 흡음재가 해당 반사 경로만 줄인다 (위치 의존)', () => {
  // 스피커가 C벽을 향하고(직접음은 축에서 90° 벗어남) C벽 반사가 지배적인 배치
  const s = pa({ x: 2, y: 1.5, z: 1.5, yaw: -90, pitch: 0 });
  const m = { model: 'omni', x: 4, y: 1.5, z: 1.5, yaw: 0, pitch: 0 };
  const fr = A.firstReflectionPoint(room, 'C', s, m);
  assert.ok(fr && Math.abs(fr.u - 3) < 1e-9 && Math.abs(fr.v - 1.5) < 1e-9, 'C벽 1차 반사 지점 = (3, 1.5)');
  const at = { surface: 'C', type: 'panel100', u: 3, v: 1.5, w: 1.2, h: 1.2 };
  const far = { surface: 'C', type: 'panel100', u: 5.3, v: 1.5, w: 1.2, h: 1.2 };
  const c0 = A.prepare(room), c1 = A.prepare({ ...room, patches: [at] }), c2 = A.prepare({ ...room, patches: [far] });
  // 메커니즘: C벽 이미지 경로의 반사 재질
  const refl = (ctx) => A.collectReflections(ctx, s.x, -s.y, s.z, m.x, m.y, m.z, []);
  assert.strictEqual(refl(c1)[0], c1.lnB.panel100);
  assert.strictEqual(refl(c2)[0], c2.lnB.gypsum);
  // 에너지: 1–4 kHz 초기음
  const band = (ctx) => { const r = A.evaluate(ctx, [s], [m], OPTS); let s2 = 0, n = 0; ctx.freqs.forEach((f, i) => { if (f >= 1000 && f <= 4000) { s2 += 10 ** (r.earlyDb[i] / 10); n++; } }); return 10 * Math.log10(s2 / n); };
  const e0 = band(c0), e1 = band(c1), e2 = band(c2);
  assert.ok(e0 - e1 > 2, `반사 지점 흡음 효과 ${e0 - e1} dB`);
  assert.ok(e0 - e1 > (e0 - e2) + 2, `반사 지점 ${e0 - e1} dB vs 먼 곳 ${e0 - e2} dB`);
});

test('둘레 좌표 ↔ 벽 위치 변환', () => {
  for (const t of [0.5, 3, 6.4, 8, 11, 14.5, 19]) {
    const p = A.perimeterToPose(room, t);
    const back = A.poseToPerimeter(room, p.x, p.y);
    const wallDist = Math.min(p.x, room.L - p.x, p.y, room.W - p.y);
    assert.ok(Math.abs(wallDist - A.WALL_OFFSET) < 1e-9, '벽에서 일정 거리');
    assert.strictEqual(A.nearestWall(room, p.x, p.y), p.wall);
    assert.strictEqual(A.perimeterToPose(room, back.t).wall, p.wall);
  }
});

test('자동 배치: 스피커는 항상 벽에 붙고, 결과는 현재보다 나쁘지 않다', () => {
  const cfg = { speakers: [pa(), pa({ y: 3.9, yaw: -20 }), amp(), amp({ type: 'basscombo', power: 300, sens: 97, x: 5.8, y: 3.3, yaw: 180, pitch: 0 })], mics: [mic()], people };
  const res = A.createOptimizer(room, cfg, Object.assign({ seed: 7, optPA: true, optInst: true, optMic: true }, OPTS)).runSync();
  assert.ok(res.margin > res.before.margin + 3, `${res.before.margin} -> ${res.margin}`);
  for (const s of res.config.speakers) {
    const d = Math.min(s.x, room.L - s.x, s.y, room.W - s.y);
    assert.ok(Math.abs(d - A.WALL_OFFSET) < 1e-6, `벽에서 ${d} m`);
    if (s.routed) assert.ok(s.pitch >= -45 && s.pitch <= 15 && s.z >= 1.5 - 1e-9);
    else assert.ok(s.z <= 0.8 + 1e-9 && s.pitch >= 0);
  }
  const m = res.config.mics[0];
  assert.ok(m.x >= 0.5 && m.x <= room.L - 0.5 && m.y >= 0.5 && m.y <= room.W - 0.5);
});

test('마이크만 최적화: 스피커는 그대로, 마이크만 움직인다', () => {
  const cfg = { speakers: [pa(), pa({ y: 3.9, yaw: -20 }), amp()], mics: [mic()], people };
  const res = A.createOptimizer(room, cfg, Object.assign({ seed: 3, optPA: false, optInst: false, optMic: true }, OPTS)).runSync();
  res.config.speakers.forEach((s, i) => ['x', 'y', 'z', 'yaw', 'pitch'].forEach((k) => assert.strictEqual(s[k], cfg.speakers[i][k])));
  assert.ok(res.margin >= res.before.margin);
  assert.ok(res.margin > res.before.margin + 3, `${res.before.margin} -> ${res.margin}`);
});

test('흡음재 추천: 딱딱한 방에서 잔향을 줄이고, 예산을 지키며, 위치·양을 제시한다', () => {
  const hardRoom = { ...room, surfaces: { A: 'gypsum', B: 'gypsum', C: 'gypsum', D: 'gypsum', floor: 'vinyl', ceil: 'gypsum' } };
  const plan = A.createAbsorberPlanner(hardRoom, [pa(), pa({ y: 3.9, yaw: -20 })], [mic()], Object.assign({ budget: 10 }, OPTS)).runSync();
  assert.ok(plan.steps.length >= 2);
  assert.ok(plan.usedArea <= 10 + 1e-9);
  assert.ok(plan.end.rtMid < plan.start.rtMid - 0.2, `${plan.start.rtMid} -> ${plan.end.rtMid}`);
  assert.ok(plan.end.margin >= plan.start.margin);
  for (const s of plan.steps) {
    assert.ok(A.SURFACES.includes(s.surface) && A.MATERIALS[s.type] && s.area > 0);
    const [uLen, vLen] = A.surfaceDims(hardRoom, s.surface);
    assert.ok(s.u - s.w / 2 >= -1e-9 && s.u + s.w / 2 <= uLen + 1e-9 && s.v - s.h / 2 >= -1e-9 && s.v + s.h / 2 <= vLen + 1e-9);
  }
});

test('흡음재 이어서 추가: 기존 흡음재는 그대로, 새 면적만큼 겹치지 않는 다음 위치에 추가', () => {
  const hardRoom = { ...room, surfaces: { A: 'gypsum', B: 'gypsum', C: 'gypsum', D: 'gypsum', floor: 'vinyl', ceil: 'gypsum' } };
  const spk = [pa(), pa({ y: 3.9, yaw: -20 })];
  const first = A.createAbsorberPlanner(hardRoom, spk, [mic()], Object.assign({ budget: 6 }, OPTS)).runSync();
  const more = A.createAbsorberPlanner({ ...hardRoom, patches: first.patches }, spk, [mic()], Object.assign({ budget: 3, minGain: 0.02 }, OPTS)).runSync();
  assert.ok(more.steps.length >= 1);
  assert.ok(more.usedArea <= 3 + 1e-9 && more.usedArea > 0);
  // 기존 흡음재는 유지되고 새 것이 뒤에 붙는다
  assert.deepStrictEqual(more.patches.slice(0, first.patches.length), first.patches);
  assert.strictEqual(more.patches.length, first.patches.length + more.steps.length);
  // 이어서 시작: 첫 결과의 끝 상태에서 출발하고 더 좋아진다
  assert.ok(Math.abs(more.start.rtMid - first.end.rtMid) < 1e-9);
  assert.ok(more.end.rtMid < more.start.rtMid);
  // 같은 표면의 기존 흡음재와 30% 넘게 겹치지 않는다
  for (const st of more.steps) {
    const a = A.clipPatch(hardRoom, st);
    for (const p of first.patches.filter((q) => q.surface === st.surface)) {
      const b = A.clipPatch(hardRoom, p);
      const ov = Math.max(0, Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0)) * Math.max(0, Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0));
      assert.ok(ov <= 0.3 * a.area + 1e-9);
    }
  }
});
