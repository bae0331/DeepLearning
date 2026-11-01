/*
 * 하울링(음향 피드백) 시뮬레이션 엔진
 *
 * 모델 개요
 *  - 루프 게인 = 마이크 → 앰프/믹서(전기적 게인) → 스피커 → 실내 전달경로 → 마이크
 *  - 전기적 게인: 마이크에 기준 음압(Lref, dB SPL)이 들어올 때 볼륨 100%에서 스피커가
 *    정격 출력을 내도록 게인 구조가 맞춰져 있다고 가정.
 *      스피커 1m 음압 = 감도(dB/1W/1m) + 10·log10(정격W) + 20·log10(볼륨/100)
 *      전기적 게인(dB) = 스피커 1m 음압 − Lref
 *  - 실내 전달경로
 *      초기음: 직접음 + 이미지 소스법(Allen–Berkley) 반사음을 위상까지 포함해 코히런트 합산
 *              (주파수별 흡음률, 공기 흡음, 스피커/마이크 지향성 포함)
 *      후기 잔향: 확산음장 에너지 16π/(Q·R) · REE(마이크 랜덤 에너지 효율) · 후기 비율
 *              + 잔향 음장의 주파수 응답 피크(Schroeder)를 고려한 피크 계수
 *  - 루프 게인이 0 dB 이상인 주파수가 하나라도 있으면 하울링 발생.
 *    0 dB 아래라도 안정 여유(기본 6 dB)가 부족하면 링잉/하울링 위험.
 *
 * 좌표계: x = 방 길이(0 = 무대 쪽 벽), y = 방 폭, z = 높이 (단위 m)
 * 방향: yaw = 수평각(도, +x 방향이 0°, 반시계 +), pitch = 수직각(도, 위쪽 +)
 */
(function (global) {
  'use strict';

  const C = 343; // 음속 (m/s)
  const TWO_PI = Math.PI * 2;
  const DEG = Math.PI / 180;
  const BANDS = [125, 250, 500, 1000, 2000, 4000];
  const REAR_FLOOR = Math.pow(10, -25 / 10); // 스피커 후면 최소 방사 (−25 dB)
  const LATE_PEAK_DB = 6; // 잔향 음장 주파수 응답 피크 계수

  const MATERIALS = {
    concrete: { name: '콘크리트(도장)', a: [0.01, 0.01, 0.015, 0.02, 0.02, 0.02] },
    brick: { name: '벽돌', a: [0.03, 0.03, 0.03, 0.04, 0.05, 0.07] },
    tile: { name: '타일/석재', a: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02] },
    glass: { name: '유리', a: [0.18, 0.06, 0.04, 0.03, 0.02, 0.02] },
    gypsum: { name: '석고보드', a: [0.29, 0.10, 0.05, 0.04, 0.07, 0.09] },
    wood: { name: '목재 패널', a: [0.28, 0.22, 0.17, 0.09, 0.10, 0.11] },
    woodfloor: { name: '목재 마루', a: [0.15, 0.11, 0.10, 0.07, 0.06, 0.07] },
    vinyl: { name: '비닐/리놀륨 바닥', a: [0.02, 0.03, 0.03, 0.03, 0.03, 0.02] },
    carpet: { name: '카펫', a: [0.08, 0.24, 0.57, 0.69, 0.71, 0.73] },
    curtain: { name: '두꺼운 커튼', a: [0.14, 0.35, 0.55, 0.72, 0.70, 0.65] },
    acoustictile: { name: '흡음 천장재(텍스)', a: [0.50, 0.70, 0.60, 0.70, 0.70, 0.50] },
    acoustic: { name: '흡음 패널', a: [0.30, 0.75, 0.95, 0.95, 0.90, 0.85] },
  };

  // 사람 1명당 흡음력 (m² Sabine, 착석 청중 기준)
  const PERSON_ABS = [0.25, 0.35, 0.42, 0.46, 0.50, 0.50];

  // qhf: 고역 지향 계수 Q, fl: 저역 차단 주파수(Hz)
  const SPEAKER_TYPES = {
    box: { name: '박스형 풀레인지 (90°)', qhf: 8, fl: 60 },
    horn: { name: '혼 로딩 협지향 (60°)', qhf: 15, fl: 90 },
    wide: { name: '광지향 / 소형 (120°+)', qhf: 4, fl: 80 },
    ceiling: { name: '천장 매립형', qhf: 3, fl: 90 },
    omni: { name: '무지향', qhf: 1.3, fl: 70 },
  };

  // 마이크 극성 패턴: 진폭 응답 a + (1−a)·cosφ
  const MIC_PATTERNS = {
    omni: { name: '무지향 (Omni)', a: 1 },
    cardioid: { name: '카디오이드', a: 0.5 },
    supercardioid: { name: '슈퍼카디오이드', a: 0.37 },
    hypercardioid: { name: '하이퍼카디오이드', a: 0.25 },
  };

  // ---------------------------------------------------------------- 유틸
  function freqGrid(fmin, fmax, perOct) {
    const n = Math.floor(Math.log2(fmax / fmin) * perOct) + 1;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = fmin * Math.pow(2, i / perOct);
    return out;
  }

  function interpBands(arr, f) {
    const lf = Math.log2(f / BANDS[0]);
    if (lf <= 0) return arr[0];
    if (lf >= BANDS.length - 1) return arr[BANDS.length - 1];
    const i = Math.floor(lf);
    const t = lf - i;
    return arr[i] * (1 - t) + arr[i + 1] * t;
  }

  function airAbsorption(f) {
    // 20°C, 50%RH 근사 (강도 감쇠 계수 m, 1/m)
    return 5.5e-4 * Math.pow(f / 1000, 1.7);
  }

  function speakerQ(type, f) {
    const t = SPEAKER_TYPES[type] || SPEAKER_TYPES.box;
    const s = 1 / (1 + Math.pow(700 / f, 2));
    return 1 + (t.qhf - 1) * s;
  }

  function hpfMag(f, fl) {
    const r = Math.pow(f / fl, 2);
    return r / Math.sqrt(1 + r * r);
  }

  function dirVec(yawDeg, pitchDeg) {
    const y = yawDeg * DEG;
    const p = pitchDeg * DEG;
    return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)];
  }

  function micA(pattern) {
    return (MIC_PATTERNS[pattern] || MIC_PATTERNS.cardioid).a;
  }

  function micREE(pattern) {
    const a = micA(pattern);
    return a * a + ((1 - a) * (1 - a)) / 3;
  }

  // 스피커 −6 dB 커버리지 반각(도)
  function speakerHalfAngle(type, f) {
    const q = speakerQ(type, f || 2000);
    if (q - 1 < 1e-3) return 180;
    const c = 2 * Math.pow(0.25, 1 / (q - 1)) - 1;
    return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
  }

  function speakerAmp(spk, lref) {
    if (!(spk.volume > 0) || !(spk.power > 0)) return 0;
    const l1 = spk.sens + 10 * Math.log10(spk.power) + 20 * Math.log10(spk.volume / 100);
    return Math.pow(10, (l1 - lref) / 20);
  }

  // ---------------------------------------------------------------- 실내 준비
  function prepare(room, opts) {
    opts = opts || {};
    const perOct = opts.perOct || 48;
    const fmin = opts.fmin || 63;
    const fmax = opts.fmax || 8000;
    const order = opts.order == null ? 2 : opts.order;
    const freqs = freqGrid(fmin, fmax, perOct);
    const nf = freqs.length;
    const L = room.L, W = room.W, H = room.H;
    const V = L * W * H;
    const Sw = 2 * (L * H + W * H), Sf = L * W, Sc = L * W;
    const S = Sw + Sf + Sc;
    const mw = MATERIALS[room.wall] || MATERIALS.gypsum;
    const mf = MATERIALS[room.floor] || MATERIALS.woodfloor;
    const mc = MATERIALS[room.ceil] || MATERIALS.gypsum;

    const k = new Float64Array(nf);
    const lnBw = new Float64Array(nf), lnBf = new Float64Array(nf), lnBc = new Float64Array(nf);
    const airHalf = new Float64Array(nf);
    const T60 = new Float64Array(nf), R = new Float64Array(nf), lateFrac = new Float64Array(nf);
    const alphaMean = new Float64Array(nf);
    const mfp = (4 * V) / S;
    const tc = ((order + 1) * mfp) / C;
    for (let i = 0; i < nf; i++) {
      const f = freqs[i];
      k[i] = (TWO_PI * f) / C;
      const aw = Math.min(0.99, interpBands(mw.a, f));
      const af = Math.min(0.99, interpBands(mf.a, f));
      const ac = Math.min(0.99, interpBands(mc.a, f));
      lnBw[i] = 0.5 * Math.log(1 - aw);
      lnBf[i] = 0.5 * Math.log(1 - af);
      lnBc[i] = 0.5 * Math.log(1 - ac);
      const m = airAbsorption(f);
      airHalf[i] = m / 2;
      const people = Math.max(0, room.people || 0) * interpBands(PERSON_ABS, f);
      const am = Math.min(0.99, (Sw * aw + Sf * af + Sc * ac + people) / S);
      alphaMean[i] = am;
      // Eyring + 공기 흡음
      T60[i] = (0.161 * V) / (-S * Math.log(1 - am) + 4 * m * V);
      R[i] = (S * am) / (1 - am) + 4 * m * V;
      lateFrac[i] = Math.exp((-13.82 * tc) / T60[i]);
    }

    // 이미지 소스 템플릿 (Allen–Berkley)
    const images = [];
    for (let l = -order; l <= order; l++)
      for (let m = -order; m <= order; m++)
        for (let n = -order; n <= order; n++)
          for (let p = 0; p <= 1; p++)
            for (let q = 0; q <= 1; q++)
              for (let r = 0; r <= 1; r++) {
                const nW = Math.abs(l - p) + Math.abs(l) + Math.abs(m - q) + Math.abs(m);
                const nF = Math.abs(n - r);
                const nC = Math.abs(n);
                if (nW + nF + nC > order) continue;
                images.push({
                  sx: 1 - 2 * p, sy: 1 - 2 * q, sz: 1 - 2 * r,
                  ox: 2 * l * L, oy: 2 * m * W, oz: 2 * n * H,
                  nW, nF, nC,
                });
              }

    // 스피커 타입별 주파수 데이터
    const typeData = {};
    for (const key of Object.keys(SPEAKER_TYPES)) {
      const qm1 = new Float64Array(nf), hpf = new Float64Array(nf), late = new Float64Array(nf);
      for (let i = 0; i < nf; i++) {
        const q = speakerQ(key, freqs[i]);
        qm1[i] = q - 1;
        hpf[i] = hpfMag(freqs[i], SPEAKER_TYPES[key].fl);
        late[i] = ((16 * Math.PI) / (q * R[i])) * lateFrac[i] * Math.pow(10, LATE_PEAK_DB / 10);
      }
      typeData[key] = { qm1, hpf, late };
    }

    return {
      room: { ...room }, freqs, nf, k, lnBw, lnBf, lnBc, airHalf, T60, R, lateFrac,
      alphaMean, images, typeData, V, S, order,
    };
  }

  // ---------------------------------------------------------------- 스피커→마이크 전달
  // 한 쌍(스피커, 마이크)의 복소 전달함수를 re/im/late 배열에 누적
  function addPair(ctx, spk, mic, amp, re, im, late) {
    if (amp <= 0) return;
    const td = ctx.typeData[spk.type] || ctx.typeData.box;
    const sd = dirVec(spk.yaw, spk.pitch);
    const md = dirVec(mic.yaw, mic.pitch);
    const a = micA(mic.pattern);
    const nf = ctx.nf;
    const { k, lnBw, lnBf, lnBc, airHalf } = ctx;
    const qm1 = td.qm1, hpf = td.hpf;

    for (let ii = 0; ii < ctx.images.length; ii++) {
      const img = ctx.images[ii];
      const ix = img.sx * spk.x + img.ox;
      const iy = img.sy * spk.y + img.oy;
      const iz = img.sz * spk.z + img.oz;
      const dx = mic.x - ix, dy = mic.y - iy, dz = mic.z - iz;
      let r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (r < 0.1) r = 0.1;
      const ux = dx / r, uy = dy / r, uz = dz / r;
      // 스피커에서의 방사 방향 (이미지 반전 보정)
      const cosS = ux * img.sx * sd[0] + uy * img.sy * sd[1] + uz * img.sz * sd[2];
      const lnBase = Math.log(Math.max(1e-9, (1 + cosS) / 2));
      // 마이크 입사 방향 (마이크에서 본 음원 방향)
      const cosM = -(ux * md[0] + uy * md[1] + uz * md[2]);
      const mresp = a + (1 - a) * cosM;
      const pre = (amp * mresp) / r;
      if (Math.abs(pre) < 1e-9) continue;
      const nW = img.nW, nF = img.nF, nC = img.nC;
      for (let i = 0; i < nf; i++) {
        const g = (1 - REAR_FLOOR) * Math.exp(lnBase * qm1[i]) + REAR_FLOOR;
        const refl = Math.exp(nW * lnBw[i] + nF * lnBf[i] + nC * lnBc[i] - airHalf[i] * r);
        const A = pre * Math.sqrt(g) * refl * hpf[i];
        const ph = k[i] * r;
        re[i] += A * Math.cos(ph);
        im[i] -= A * Math.sin(ph);
      }
    }
    const ree = micREE(mic.pattern);
    const lt = td.late;
    for (let i = 0; i < nf; i++) late[i] += amp * amp * hpf[i] * hpf[i] * lt[i] * ree;
  }

  // ---------------------------------------------------------------- 루프 게인 평가
  function evaluate(ctx, speakers, mics, opts) {
    opts = opts || {};
    const lref = opts.lref == null ? 105 : opts.lref;
    const nf = ctx.nf;
    const re = new Float64Array(nf), im = new Float64Array(nf), late = new Float64Array(nf);
    const amps = speakers.map((s) => speakerAmp(s, lref));
    for (const mic of mics) {
      speakers.forEach((s, si) => addPair(ctx, s, mic, amps[si], re, im, late));
    }
    // 마이크 채널 로우컷(HPF, 2차) — 보컬 채널 기본 처리
    const micHpf = opts.micHpf == null ? 100 : opts.micHpf;
    const db = new Float64Array(nf), earlyDb = new Float64Array(nf), lateDb = new Float64Array(nf);
    let maxDb = -Infinity, iMax = 0;
    for (let i = 0; i < nf; i++) {
      const h = micHpf > 0 ? hpfMag(ctx.freqs[i], micHpf) : 1;
      const h2 = h * h;
      const pe = (re[i] * re[i] + im[i] * im[i]) * h2;
      const pl = late[i] * h2;
      earlyDb[i] = 10 * Math.log10(pe + 1e-20);
      lateDb[i] = 10 * Math.log10(pl + 1e-20);
      db[i] = 10 * Math.log10(pe + pl + 1e-20);
      if (db[i] > maxDb) { maxDb = db[i]; iMax = i; }
    }
    return { freqs: ctx.freqs, db, earlyDb, lateDb, maxDb, fMax: ctx.freqs[iMax], iMax, margin: -maxDb };
  }

  // 특정 주파수에서 각 (스피커, 마이크) 쌍의 기여도 (dB)
  function pairContributions(ctx, speakers, mics, iFreq, opts) {
    const lref = (opts && opts.lref) == null ? 105 : opts.lref;
    const out = [];
    speakers.forEach((s, si) => {
      mics.forEach((m, mi) => {
        const re = new Float64Array(ctx.nf), im = new Float64Array(ctx.nf), late = new Float64Array(ctx.nf);
        addPair(ctx, s, m, speakerAmp(s, lref), re, im, late);
        const micHpf = (opts && opts.micHpf) == null ? 100 : opts.micHpf;
        const h = micHpf > 0 ? hpfMag(ctx.freqs[iFreq], micHpf) : 1;
        const p = (re[iFreq] ** 2 + im[iFreq] ** 2 + late[iFreq]) * h * h;
        // 직접음만
        const dx = m.x - s.x, dy = m.y - s.y, dz = m.z - s.z;
        const r = Math.max(0.1, Math.hypot(dx, dy, dz));
        const sd = dirVec(s.yaw, s.pitch), md = dirVec(m.yaw, m.pitch);
        const spkAngle = Math.acos(Math.max(-1, Math.min(1, (dx * sd[0] + dy * sd[1] + dz * sd[2]) / r))) / DEG;
        const micAngle = Math.acos(Math.max(-1, Math.min(1, -(dx * md[0] + dy * md[1] + dz * md[2]) / r))) / DEG;
        out.push({ si, mi, db: 10 * Math.log10(p + 1e-20), dist: r, spkAngle, micAngle });
      });
    });
    return out;
  }

  // 주파수 응답의 국소 최대값 (EQ 컷 후보)
  function peaks(result, withinDb, maxCount) {
    const { db, freqs } = result;
    const list = [];
    for (let i = 1; i < db.length - 1; i++) {
      if (db[i] >= db[i - 1] && db[i] >= db[i + 1] && db[i] >= result.maxDb - withinDb) {
        list.push({ f: freqs[i], db: db[i] });
      }
    }
    list.sort((a, b) => b.db - a.db);
    // 1/3 옥타브 안에 겹치는 피크 제거
    const out = [];
    for (const p of list) {
      if (out.every((q) => Math.abs(Math.log2(p.f / q.f)) > 1 / 3)) out.push(p);
      if (out.length >= (maxCount || 3)) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- 청중 커버리지
  function audiencePoints(room, nx, ny, earZ) {
    const pts = [];
    const x0 = Math.min(room.L - 0.5, room.stage + 0.5);
    const x1 = room.L - 0.5;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        pts.push({
          x: nx === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (nx - 1),
          y: 0.5 + ((room.W - 1) * j) / Math.max(1, ny - 1),
          z: earZ || 1.2,
        });
      }
    return pts;
  }

  // 2 kHz 기준 직접음 + 잔향음 에너지
  function splAt(ctx, speakers, pt, opts) {
    const lref = (opts && opts.lref) == null ? 105 : opts.lref;
    const f = 2000;
    let i2k = 0;
    for (let i = 0; i < ctx.nf; i++) if (Math.abs(ctx.freqs[i] - f) < Math.abs(ctx.freqs[i2k] - f)) i2k = i;
    const R = ctx.R[i2k];
    let D = 0, Rv = 0;
    for (const s of speakers) {
      const amp = speakerAmp(s, lref);
      if (amp <= 0) continue;
      const q = speakerQ(s.type, f);
      const sd = dirVec(s.yaw, s.pitch);
      const dx = pt.x - s.x, dy = pt.y - s.y, dz = pt.z - s.z;
      const r = Math.max(0.3, Math.hypot(dx, dy, dz));
      const cosS = (dx * sd[0] + dy * sd[1] + dz * sd[2]) / r;
      const g = (1 - REAR_FLOOR) * Math.pow((1 + cosS) / 2, q - 1) + REAR_FLOOR;
      D += (amp * amp * g) / (r * r);
      Rv += (amp * amp * 16 * Math.PI) / (q * R);
    }
    return { spl: 10 * Math.log10(D + Rv + 1e-20) + lref, dr: 10 * Math.log10((D + 1e-20) / (Rv + 1e-20)) };
  }

  function coverage(ctx, speakers, pts, opts) {
    let sum = 0, sum2 = 0, drSum = 0;
    for (const p of pts) {
      const r = splAt(ctx, speakers, p, opts);
      sum += r.spl; sum2 += r.spl * r.spl; drSum += Math.max(-15, Math.min(15, r.dr));
    }
    const n = pts.length;
    const mean = sum / n;
    return { meanSpl: mean, stdSpl: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), meanDR: drSum / n };
  }

  // ---------------------------------------------------------------- 점수
  function score(margin, cov, opts) {
    const req = opts.reqMargin == null ? 6 : opts.reqMargin;
    const w = opts.weight == null ? 0.4 : opts.weight;
    // 안정성: 필요 여유까지는 강하게, 그 이후는 완만하게(최대 +10 dB까지만) 보상
    const stab = margin < req ? req + 3 * (margin - req) : req + 0.6 * Math.min(10, margin - req);
    const cv = -cov.stdSpl + 0.4 * cov.meanDR;
    return (1 - w) * stab + w * cv * 1.5;
  }

  // ---------------------------------------------------------------- 최적화
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function cloneCfg(cfg) {
    return { speakers: cfg.speakers.map((s) => ({ ...s })), mics: cfg.mics.map((m) => ({ ...m })) };
  }

  function buildParams(room, cfg, o) {
    const params = [];
    const L = room.L, W = room.W, H = room.H;
    if (o.optSpk) {
      // zone 'front': 무대/객석 앞부분에 두고 객석을 향하게 (일반적인 메인 스피커 배치)
      // zone 'any'  : 방 전체 (분산형 배치). 천장형은 항상 방 전체.
      cfg.speakers.forEach((s, i) => {
        const S = (key) => ({ get: (c) => c.speakers[i][key], set: (c, v) => { c.speakers[i][key] = v; } });
        const front = o.zone !== 'any' && s.type !== 'ceiling';
        const xHi = front ? Math.min(L - 0.2, Math.max(1, room.stage + 2.5)) : L - 0.2;
        params.push({ ...S('x'), lo: 0.2, hi: xHi, kind: 'pos' });
        params.push({ ...S('y'), lo: 0.2, hi: W - 0.2, kind: 'pos' });
        if (s.type !== 'ceiling') {
          params.push({ ...S('z'), lo: Math.min(1.8, H - 0.4), hi: H - 0.15, kind: 'pos' });
          if (front) params.push({ ...S('yaw'), lo: -80, hi: 80, kind: 'ang' });
          else params.push({ ...S('yaw'), lo: -180, hi: 180, circ: true, kind: 'ang' });
          params.push({ ...S('pitch'), lo: -60, hi: 10, kind: 'ang' });
        }
      });
    }
    if (o.optMic) {
      cfg.mics.forEach((m, i) => {
        const M = (key) => ({ get: (c) => c.mics[i][key], set: (c, v) => { c.mics[i][key] = v; } });
        params.push({ ...M('x'), lo: 0.3, hi: Math.max(0.6, Math.min(L - 0.3, room.stage)), kind: 'pos' });
        params.push({ ...M('y'), lo: 0.3, hi: W - 0.3, kind: 'pos' });
        params.push({ ...M('yaw'), lo: 135, hi: 225, kind: 'ang' });
      });
    }
    return params;
  }

  function clampParam(p, v) {
    if (p.circ) {
      const span = p.hi - p.lo;
      v = ((((v - p.lo) % span) + span) % span) + p.lo;
      return v;
    }
    return Math.max(p.lo, Math.min(p.hi, v));
  }

  /**
   * 점진적 최적화기. step(ms)를 반복 호출 (UI 비차단).
   * options: { optSpk, optMic, zone, weight, reqMargin, lref, order, seed, nRandom, nStarts, iters }
   */
  function createOptimizer(room, cfg0, options) {
    const o = Object.assign(
      { optSpk: true, optMic: true, zone: 'front', weight: 0.4, reqMargin: 6, lref: 105, micHpf: 100, order: 2, seed: 12345,
        nRandom: 500, nStarts: 6, iters: 220 },
      options || {}
    );
    const rng = mulberry32(o.seed);
    const gauss = () => {
      let u = 0, v = 0;
      while (u === 0) u = rng();
      while (v === 0) v = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
    };
    const ctxFast = prepare(room, { perOct: 24, order: o.order });
    const ctxFine = prepare(room, { perOct: 48, order: o.order });
    const pts = audiencePoints(room, 6, 5, 1.2);
    const base = cloneCfg(cfg0);
    // 클램프: 현재 배치를 파라미터 범위 안으로
    const params = buildParams(room, base, o);

    function decode(vec) {
      const c = cloneCfg(base);
      params.forEach((p, i) => p.set(c, vec[i]));
      return c;
    }
    function evalVec(vec, ctx) {
      const c = decode(vec);
      const r = evaluate(ctx, c.speakers, c.mics, o);
      const cov = coverage(ctx, c.speakers, pts, o);
      return { s: score(r.margin, cov, o), margin: r.margin, cov };
    }
    const cur = params.map((p) => p.get(base));
    const curClamped = params.map((p, i) => clampParam(p, cur[i]));

    const pool = []; // {vec, s}
    let phase = 'random', iRand = 0, iStart = 0, iIter = 0, evals = 0;
    let local = null;
    const finalists = [];
    let result = null;
    const totalWork = o.nRandom + o.nStarts * o.iters + 1;

    function randomVec() {
      return params.map((p) => p.lo + (p.hi - p.lo) * rng());
    }

    function stepOnce() {
      if (phase === 'random') {
        const vec = iRand === 0 ? curClamped.slice() : randomVec();
        const e = evalVec(vec, ctxFast);
        evals++;
        pool.push({ vec, s: e.s });
        iRand++;
        if (iRand >= o.nRandom) {
          pool.sort((a, b) => b.s - a.s);
          phase = 'local';
        }
        return;
      }
      if (phase === 'local') {
        if (!local) {
          // 다양성 확보: 위치가 충분히 다른 시작점 선택
          const starts = [];
          for (const c of pool) {
            if (starts.length >= o.nStarts) break;
            const diff = starts.every((s) =>
              params.some((p, i) => p.kind === 'pos' && Math.abs(s.vec[i] - c.vec[i]) > 0.8)
            );
            if (diff || starts.length === 0) starts.push(c);
          }
          while (starts.length < o.nStarts) starts.push(pool[starts.length]);
          local = { starts, cur: null };
        }
        if (!local.cur) {
          local.cur = { vec: local.starts[iStart].vec.slice(), s: local.starts[iStart].s };
          iIter = 0;
        }
        const t = iIter / o.iters;
        const sigma = 0.2 * (1 - t) + 0.015;
        const cand = local.cur.vec.slice();
        const nChange = 1 + Math.floor(rng() * Math.min(3, params.length));
        for (let c = 0; c < nChange; c++) {
          const i = Math.floor(rng() * params.length);
          const p = params[i];
          cand[i] = clampParam(p, cand[i] + gauss() * sigma * (p.hi - p.lo));
        }
        const e = evalVec(cand, ctxFast);
        evals++;
        if (e.s >= local.cur.s) local.cur = { vec: cand, s: e.s };
        iIter++;
        if (iIter >= o.iters) {
          finalists.push(local.cur);
          local.cur = null;
          iStart++;
          if (iStart >= local.starts.length) phase = 'final';
        }
        return;
      }
      if (phase === 'final') {
        // 정밀 격자 + 위치 오차(±10 cm, ±5°)에 대한 강건성 평가
        finalists.push({ vec: curClamped.slice(), s: -Infinity, isCurrent: true });
        let best = null;
        for (const f of finalists) {
          const nominal = evalVec(f.vec, ctxFine);
          let worst = nominal.margin;
          for (let j = 0; j < 4; j++) {
            const jv = f.vec.map((v, i) => clampParam(params[i], v + (params[i].kind === 'pos' ? 0.1 : 5) * gauss()));
            worst = Math.min(worst, evalVec(jv, ctxFine).margin);
          }
          const robustMargin = Math.min(nominal.margin, worst + 1.5);
          const s = score(robustMargin, nominal.cov, o);
          const entry = { vec: f.vec, s, margin: nominal.margin, robustMargin, cov: nominal.cov, isCurrent: !!f.isCurrent };
          if (!best || entry.s > best.s) best = entry;
        }
        const curEval = evalVec(cur, ctxFine);
        result = {
          config: decode(best.vec),
          margin: best.margin,
          robustMargin: best.robustMargin,
          coverage: best.cov,
          keptCurrent: best.isCurrent,
          before: { margin: curEval.margin, coverage: curEval.cov },
          evals,
        };
        phase = 'done';
      }
    }

    return {
      get done() { return phase === 'done'; },
      get progress() {
        if (phase === 'done') return 1;
        const work = iRand + iStart * o.iters + (local && local.cur ? iIter : 0);
        return Math.min(0.99, work / totalWork);
      },
      get result() { return result; },
      get noParams() { return params.length === 0; },
      step(budgetMs) {
        const t0 = Date.now();
        while (phase !== 'done' && Date.now() - t0 < (budgetMs || 30)) stepOnce();
        return phase === 'done';
      },
      runSync() {
        while (phase !== 'done') stepOnce();
        return result;
      },
    };
  }

  const api = {
    C, BANDS, MATERIALS, SPEAKER_TYPES, MIC_PATTERNS, LATE_PEAK_DB,
    freqGrid, interpBands, speakerQ, speakerHalfAngle, speakerAmp, micREE, micA, dirVec,
    prepare, evaluate, pairContributions, peaks, audiencePoints, splAt, coverage, score,
    createOptimizer,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Acoustics = api;
})(typeof window !== 'undefined' ? window : globalThis);
