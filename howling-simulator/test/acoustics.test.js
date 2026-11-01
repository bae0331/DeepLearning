// 실행: node --test howling-simulator/test/acoustics.test.js
const test = require('node:test');
const assert = require('node:assert');
const A = require('../acoustics.js');

const room = { L: 12, W: 8, H: 3.2, wall: 'gypsum', floor: 'carpet', ceil: 'acoustictile', stage: 3, people: 30 };
const mic = () => ({ x: 2, y: 4, z: 1.5, yaw: 180, pitch: 0, pattern: 'cardioid' });
const spk = (o) => Object.assign({ type: 'box', power: 200, volume: 35, sens: 92, x: 0.8, y: 1.5, z: 2.2, yaw: 0, pitch: -10 }, o);
const OPTS = { lref: 105, micHpf: 100 };
const idxOf = (ctx, f) => ctx.freqs.reduce((b, x, i) => (Math.abs(Math.log(x / f)) < Math.abs(Math.log(ctx.freqs[b] / f)) ? i : b), 0);

test('흡음이 많을수록 잔향시간이 짧아진다', () => {
  const hard = A.prepare({ ...room, wall: 'concrete', floor: 'tile', ceil: 'concrete', people: 0 });
  const soft = A.prepare(room);
  const i = idxOf(soft, 1000);
  assert.ok(hard.T60[i] > 2 * soft.T60[i], `hard ${hard.T60[i]} vs soft ${soft.T60[i]}`);
  assert.ok(soft.T60[i] > 0.1 && soft.T60[i] < 1.0);
});

test('볼륨 2배(진폭) → 루프 게인 +6 dB, 출력 2배 → +3 dB', () => {
  const ctx = A.prepare(room);
  const base = A.evaluate(ctx, [spk({ volume: 25 })], [mic()], OPTS);
  const vol2 = A.evaluate(ctx, [spk({ volume: 50 })], [mic()], OPTS);
  const pow2 = A.evaluate(ctx, [spk({ volume: 25, power: 400 })], [mic()], OPTS);
  for (let i = 0; i < ctx.nf; i += 17) {
    assert.ok(Math.abs(vol2.db[i] - base.db[i] - 6.0206) < 1e-6);
    assert.ok(Math.abs(pow2.db[i] - base.db[i] - 3.0103) < 1e-6);
  }
});

test('무반사 방에서는 직접음 역제곱 법칙과 일치한다', () => {
  A.MATERIALS.__anechoic = { name: 'test', a: [0.99, 0.99, 0.99, 0.99, 0.99, 0.99] };
  const r0 = { L: 30, W: 30, H: 30, wall: '__anechoic', floor: '__anechoic', ceil: '__anechoic', stage: 3, people: 0 };
  const ctx = A.prepare(r0);
  const s = spk({ x: 10, y: 15, z: 15, yaw: 0, pitch: 0 });
  const m = { x: 14, y: 15, z: 15, yaw: 180, pitch: 0, pattern: 'omni' }; // 정면 4 m
  const r = A.evaluate(ctx, [s], [m], { lref: 105, micHpf: 0 });
  const i = idxOf(ctx, 1000);
  const elec = 92 + 10 * Math.log10(200) + 20 * Math.log10(0.35) - 105;
  const expected = elec - 20 * Math.log10(4);
  assert.ok(Math.abs(r.earlyDb[i] - expected) < 0.5, `early ${r.earlyDb[i]} vs ${expected}`);
  delete A.MATERIALS.__anechoic;
});

test('마이크 뒷면이 스피커를 향하면 루프 게인이 낮아진다', () => {
  const ctx = A.prepare(room);
  const s = [spk({ x: 6, y: 4, yaw: 180 })];
  const front = A.evaluate(ctx, s, [{ ...mic(), yaw: 0 }], OPTS); // 마이크 정면이 스피커 쪽
  const back = A.evaluate(ctx, s, [{ ...mic(), yaw: 180 }], OPTS);
  assert.ok(front.maxDb - back.maxDb > 3, `front ${front.maxDb} back ${back.maxDb}`);
});

test('스피커가 마이크를 향하면 고역(지향성 대역) 직접음 경로가 커진다', () => {
  // 저역에서는 스피커가 거의 무지향이라 차이가 작고, 고역에서 지향성 차이가 드러난다
  const ctx = A.prepare(room);
  const m = [{ ...mic(), pattern: 'omni' }];
  const at = A.evaluate(ctx, [spk({ x: 6, y: 4, yaw: 180, pitch: 0, z: 1.5 })], m, OPTS);
  const away = A.evaluate(ctx, [spk({ x: 6, y: 4, yaw: 0, pitch: 0, z: 1.5 })], m, OPTS);
  const band = (r) => { let s = 0, n = 0; ctx.freqs.forEach((f, i) => { if (f >= 1500 && f <= 3000) { s += 10 ** (r.earlyDb[i] / 10); n++; } }); return 10 * Math.log10(s / n); };
  assert.ok(band(at) - band(away) > 6, `at ${band(at)} away ${band(away)}`);
});

test('최적화 결과는 현재보다 나쁘지 않고 제약 조건을 지킨다', () => {
  const cfg = { speakers: [spk({}), spk({ y: 6.5 })], mics: [mic()] };
  const res = A.createOptimizer(room, cfg, { seed: 7, ...OPTS }).runSync();
  assert.ok(res.margin >= res.before.margin - 0.5, `${res.before.margin} -> ${res.margin}`);
  assert.ok(res.margin > res.before.margin + 3, '기본 예제에서는 의미 있는 개선이 있어야 함');
  for (const m of res.config.mics) {
    assert.ok(m.x <= room.stage + 1e-9 && m.x >= 0.3, 'mic in stage');
    assert.ok(m.yaw >= 135 && m.yaw <= 225, 'talker faces audience');
  }
  for (const s of res.config.speakers) {
    assert.ok(s.x >= 0.2 && s.x <= room.stage + 2.5 + 1e-9 && s.y >= 0.2 && s.y <= room.W - 0.2);
    assert.ok(s.z >= 1.8 - 1e-9 && s.z <= room.H - 0.15 + 1e-9);
    assert.ok(s.yaw >= -80 && s.yaw <= 80, 'front zone speakers face audience');
  }
});
