/*
 * 하울링(음향 피드백) 시뮬레이션 엔진 — 합주실/소규모 공간용
 *
 * 모델 개요
 *  - 루프 게인 = 마이크 → 믹서/앰프(전기적 게인) → "보컬 신호를 출력하는" 스피커 → 실내 전달 → 마이크
 *    (기타/베이스 앰프처럼 마이크 신호를 내보내지 않는 스피커는 하울링 루프에 들어가지 않고,
 *     마이크로 새어 들어가는 악기 소리(블리드)와 실내 음장에만 영향을 준다)
 *  - 전기적 게인: 마이크에 기준 음압(Lref, dB SPL)이 들어올 때 볼륨 100%에서 스피커가 정격 출력을 낸다고 가정
 *      스피커 1m 음압 = 감도(dB/1W/1m) + 10·log10(정격W) + 20·log10(볼륨/100)
 *  - 실내 전달
 *      초기음: 직접음 + 이미지 소스법(Allen–Berkley) 2차 반사까지 위상 포함 합산.
 *              반사가 일어나는 "벽 위의 실제 지점"을 계산해 그 지점의 재질/흡음재 흡음률을 적용.
 *      후기 잔향: Eyring 잔향시간, 실정수 R → 확산음장 16π/(Q·R) · REE · 후기 비율 · 피크 계수
 *  - 0 dB 이상이면 하울링, 필요 여유(기본 6 dB)보다 작으면 위험.
 *
 * 좌표계 (평면도 기준): x = 길이 방향(A벽 x=0 → B벽 x=L), y = 폭 방향(C벽 y=0 → D벽 y=W), z = 높이
 * 방향: yaw = 좌우 방향(도, +x가 0°, 반시계 +), pitch = 상하 각도(도, 위 +, 아래 −)
 */
(function (global) {
  'use strict';

  const C = 343;
  const TWO_PI = Math.PI * 2;
  const DEG = Math.PI / 180;
  const BANDS = [125, 250, 500, 1000, 2000, 4000];
  const REAR_FLOOR = Math.pow(10, -25 / 10); // 스피커 후면 최소 방사 (−25 dB)
  const LATE_PEAK_DB = 6; // 잔향 음장 주파수 응답 피크 계수
  const PANEL_AREA = 0.72; // 60×120 cm 흡음 패널 1장

  // 옥타브 밴드 흡음률 (125 Hz – 4 kHz)
  const MATERIALS = {
    concrete: { name: '콘크리트(도장)', a: [0.01, 0.01, 0.015, 0.02, 0.02, 0.02] },
    brick: { name: '벽돌', a: [0.03, 0.03, 0.03, 0.04, 0.05, 0.07] },
    tile: { name: '타일/석재', a: [0.01, 0.01, 0.01, 0.02, 0.02, 0.02] },
    glass: { name: '유리/거울', a: [0.18, 0.06, 0.04, 0.03, 0.02, 0.02] },
    gypsum: { name: '석고보드', a: [0.29, 0.10, 0.05, 0.04, 0.07, 0.09] },
    wood: { name: '목재 패널', a: [0.28, 0.22, 0.17, 0.09, 0.10, 0.11] },
    woodfloor: { name: '목재 마루', a: [0.15, 0.11, 0.10, 0.07, 0.06, 0.07] },
    vinyl: { name: '비닐/장판', a: [0.02, 0.03, 0.03, 0.03, 0.03, 0.02] },
    carpet: { name: '카펫/러그', a: [0.08, 0.24, 0.57, 0.69, 0.71, 0.73] },
    curtain: { name: '두꺼운 커튼', a: [0.14, 0.35, 0.55, 0.72, 0.70, 0.65] },
    acoustictile: { name: '흡음 천장재(텍스)', a: [0.50, 0.70, 0.60, 0.70, 0.70, 0.50] },
    foam25: { name: '흡음 스펀지(계란판) 25mm', a: [0.05, 0.10, 0.30, 0.55, 0.70, 0.75] },
    panel50: { name: '흡음 패널 50mm (글라스울/폴리에스터)', a: [0.17, 0.60, 0.95, 0.99, 0.97, 0.95] },
    panel100: { name: '흡음 패널 100mm', a: [0.55, 0.95, 0.99, 0.99, 0.97, 0.95] },
    basstrap: { name: '코너 베이스트랩 (200mm 이상)', a: [0.80, 0.99, 0.99, 0.99, 0.95, 0.90] },
    acoustic: { name: '흡음재 (일반)', a: [0.30, 0.75, 0.95, 0.95, 0.90, 0.85] },
  };

  // 흡음재로 붙일 수 있는 종류
  const ABSORBERS = ['panel50', 'panel100', 'foam25', 'curtain', 'basstrap', 'carpet'];

  const SURFACES = ['A', 'B', 'C', 'D', 'floor', 'ceil'];
  const SURFACE_NAMES = { A: 'A벽 (왼쪽)', B: 'B벽 (오른쪽)', C: 'C벽 (아래쪽)', D: 'D벽 (위쪽)', floor: '바닥', ceil: '천장' };

  // 사람 1명당 흡음력 (m² Sabine)
  const PERSON_ABS = [0.25, 0.35, 0.42, 0.46, 0.50, 0.50];

  // qhf: 고역 지향 계수 Q, fl/fh: 재생 대역 하한/상한(Hz)
  const SPEAKER_TYPES = {
    box: { name: 'PA 스피커 (박스형 90°)', qhf: 8, fl: 60, fh: 18000 },
    horn: { name: '혼 로딩 협지향 (60°)', qhf: 15, fl: 90, fh: 18000 },
    wide: { name: '광지향 / 소형 (120°+)', qhf: 4, fl: 80, fh: 18000 },
    frfr: { name: 'FRFR 기타 캐비닛', qhf: 6, fl: 70, fh: 16000 },
    gtrcombo: { name: '기타 콤보 앰프', qhf: 4, fl: 80, fh: 6000 },
    basscombo: { name: '베이스 콤보 앰프', qhf: 5, fl: 40, fh: 4000 },
    ceiling: { name: '천장 매립형', qhf: 3, fl: 90, fh: 18000 },
    omni: { name: '무지향', qhf: 1.3, fl: 70, fh: 18000 },
  };

  // 모델 프리셋 (출력·감도는 공개 사양 기반의 대략적인 값 — 실제 제품 사양으로 수정 가능)
  const SPEAKER_MODELS = {
    custom: { name: '직접 입력' },
    pa12: { name: 'PA 스피커 12인치 (일반)', type: 'box', power: 300, sens: 97, routed: true },
    pa15: { name: 'PA 스피커 15인치 (일반)', type: 'box', power: 400, sens: 98, routed: true },
    frfr112: { name: 'HeadRush FRFR-112', type: 'frfr', power: 1000, sens: 98, routed: false },
    frfr108: { name: 'HeadRush FRFR-108', type: 'frfr', power: 1000, sens: 94, routed: false },
    idcore10: { name: 'Blackstar ID:Core 10 V3', type: 'gtrcombo', power: 10, sens: 86, routed: false },
    idcore20: { name: 'Blackstar ID:Core 20 V3', type: 'gtrcombo', power: 20, sens: 88, routed: false },
    idcore40: { name: 'Blackstar ID:Core 40 V3', type: 'gtrcombo', power: 40, sens: 90, routed: false },
    idcore100: { name: 'Blackstar ID:Core 100', type: 'gtrcombo', power: 100, sens: 95, routed: false },
    bass112: { name: '베이스 콤보 1x12 (100W급)', type: 'basscombo', power: 100, sens: 95, routed: false },
    bass115: { name: '베이스 콤보 1x15 (300W급)', type: 'basscombo', power: 300, sens: 97, routed: false },
  };

  // 마이크 극성 패턴: 진폭 응답 a + (1−a)·cosφ
  const MIC_PATTERNS = {
    omni: { name: '무지향 (Omni)', a: 1 },
    cardioid: { name: '카디오이드', a: 0.5 },
    supercardioid: { name: '슈퍼카디오이드', a: 0.37 },
    hypercardioid: { name: '하이퍼카디오이드', a: 0.25 },
  };

  // 마이크 모델: 지향성 + 원거리(피드백 경로) 주파수 응답
  const MIC_MODELS = {
    beta58a: { name: 'Shure Beta 58A', pattern: 'supercardioid', presence: { f: 5000, db: 4, sigma: 0.7 }, low: 90 },
    sm58: { name: 'Shure SM58', pattern: 'cardioid', presence: { f: 5000, db: 5, sigma: 0.6 }, low: 100 },
    omni: { name: '일반 무지향', pattern: 'omni' },
    cardioid: { name: '일반 카디오이드', pattern: 'cardioid' },
    supercardioid: { name: '일반 슈퍼카디오이드', pattern: 'supercardioid' },
    hypercardioid: { name: '일반 하이퍼카디오이드', pattern: 'hypercardioid' },
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

  const airAbsorption = (f) => 5.5e-4 * Math.pow(f / 1000, 1.7); // 20°C, 50%RH 근사

  function speakerQ(type, f) {
    const t = SPEAKER_TYPES[type] || SPEAKER_TYPES.box;
    const s = 1 / (1 + Math.pow(700 / f, 2));
    return 1 + (t.qhf - 1) * s;
  }

  function hpfMag(f, fl) {
    const r = Math.pow(f / fl, 2);
    return r / Math.sqrt(1 + r * r);
  }
  const lpfMag = (f, fh) => 1 / Math.sqrt(1 + Math.pow(f / fh, 4));

  function speakerResp(type, f) {
    const t = SPEAKER_TYPES[type] || SPEAKER_TYPES.box;
    return hpfMag(f, t.fl) * lpfMag(f, t.fh);
  }

  function dirVec(yawDeg, pitchDeg) {
    const y = yawDeg * DEG;
    const p = pitchDeg * DEG;
    return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)];
  }

  function micPattern(mic) {
    const m = MIC_MODELS[mic.model];
    if (m && m.pattern) return m.pattern;
    return MIC_PATTERNS[mic.pattern] ? mic.pattern : 'cardioid';
  }
  const micA = (pattern) => (MIC_PATTERNS[pattern] || MIC_PATTERNS.cardioid).a;
  function micREE(pattern) {
    const a = micA(pattern);
    return a * a + ((1 - a) * (1 - a)) / 3;
  }
  // 마이크 감도 최저점 각도
  function micNullAngle(pattern) {
    const a = micA(pattern);
    if (a >= 1) return null;
    if (a >= 0.5) return 180;
    return Math.acos(-a / (1 - a)) / DEG;
  }

  function micModelResp(model, f) {
    const m = MIC_MODELS[model];
    if (!m) return 1;
    let db = 0;
    if (m.presence) db += m.presence.db * Math.exp(-0.5 * Math.pow(Math.log2(f / m.presence.f) / m.presence.sigma, 2));
    let a = Math.pow(10, db / 20);
    if (m.low) a *= hpfMag(f, m.low);
    return a;
  }

  // 스피커 −6 dB 커버리지 반각(도)
  function speakerHalfAngle(type, f) {
    const q = speakerQ(type, f || 2000);
    if (q - 1 < 1e-3) return 180;
    const c = 2 * Math.pow(0.25, 1 / (q - 1)) - 1;
    return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
  }

  /**
   * 볼륨 노브 위치(%) → 게인(dB)
   *  audio : 실제 앰프 볼륨 노브(오디오/로그 테이퍼). 50% ≈ −21 dB, 75% ≈ −10 dB, 25% ≈ −33 dB
   *  linear: 진폭 비율 그대로 (50% = −6 dB)
   */
  function volumeDb(v, taper) {
    if (!(v > 0)) return -Infinity;
    const x = Math.min(1, v / 100);
    if (taper === 'linear') return 20 * Math.log10(x);
    return 20 * Math.log10((Math.pow(10, 2 * x) - 1) / 99);
  }

  // 스피커 1 m 정면 음압 (마이크 기준 입력 Lref 기준, dB SPL)
  function speakerLevel1m(spk, taper) {
    return spk.sens + 10 * Math.log10(spk.power) + volumeDb(spk.volume, taper);
  }

  function speakerAmp(spk, lref, taper) {
    if (!(spk.volume > 0) || !(spk.power > 0)) return 0;
    return Math.pow(10, (speakerLevel1m(spk, taper) - lref) / 20);
  }

  // 목표 게인 변화(dB)를 얻기 위한 새 볼륨(%)
  function volumeForDelta(v, deltaDb, taper) {
    if (!(v > 0)) return 0;
    const target = volumeDb(v, taper) + deltaDb;
    if (target >= 0) return 100;
    if (taper === 'linear') return 100 * Math.pow(10, target / 20);
    return 50 * Math.log10(99 * Math.pow(10, target / 20) + 1);
  }
  const isRouted = (s) => s.routed !== false;

  function fold(v, len) {
    const p = 2 * len;
    const m = ((v % p) + p) % p;
    return m <= len ? m : p - m;
  }

  // ---------------------------------------------------------------- 표면/흡음재 기하
  function normalizeRoom(room) {
    const r = Object.assign({}, room);
    const s = Object.assign({}, r.surfaces || {});
    for (const k of ['A', 'B', 'C', 'D']) if (!MATERIALS[s[k]]) s[k] = MATERIALS[r.wall] ? r.wall : 'gypsum';
    if (!MATERIALS[s.floor]) s.floor = MATERIALS[r.floor] ? r.floor : 'carpet';
    if (!MATERIALS[s.ceil]) s.ceil = MATERIALS[r.ceil] ? r.ceil : 'acoustictile';
    r.surfaces = s;
    r.patches = Array.isArray(r.patches) ? r.patches.filter((p) => SURFACES.includes(p.surface) && MATERIALS[p.type]) : [];
    r.people = Math.max(0, +r.people || 0);
    return r;
  }

  function surfaceDims(room, s) {
    if (s === 'A' || s === 'B') return [room.W, room.H];
    if (s === 'C' || s === 'D') return [room.L, room.H];
    return [room.L, room.W];
  }
  function toUV(s, x, y, z) {
    if (s === 'A' || s === 'B') return [y, z];
    if (s === 'C' || s === 'D') return [x, z];
    return [x, y];
  }
  function fromUV(room, s, u, v) {
    switch (s) {
      case 'A': return [0, u, v];
      case 'B': return [room.L, u, v];
      case 'C': return [u, 0, v];
      case 'D': return [u, room.W, v];
      case 'floor': return [u, v, 0];
      default: return [u, v, room.H];
    }
  }
  // 흡음재 사각형을 표면 안으로 클리핑
  function clipPatch(room, p) {
    const [uLen, vLen] = surfaceDims(room, p.surface);
    const w = Math.min(Math.max(0.05, +p.w || 0), uLen), h = Math.min(Math.max(0.05, +p.h || 0), vLen);
    const u = Math.max(w / 2, Math.min(uLen - w / 2, +p.u || 0));
    const v = Math.max(h / 2, Math.min(vLen - h / 2, +p.v || 0));
    return { u0: u - w / 2, u1: u + w / 2, v0: v - h / 2, v1: v + h / 2, area: w * h, u, v, w, h };
  }

  // ---------------------------------------------------------------- 실내 준비
  function prepare(roomIn, opts) {
    opts = opts || {};
    const room = normalizeRoom(roomIn);
    const perOct = opts.perOct || 48;
    const order = opts.order == null ? 2 : opts.order;
    const freqs = freqGrid(opts.fmin || 63, opts.fmax || 8000, perOct);
    const nf = freqs.length;
    const { L, W, H } = room;
    const V = L * W * H;
    const S = 2 * (L * W + L * H + W * H);

    // 표면별 기본 재질 + 흡음재
    const surf = {};
    const matKeys = new Set();
    for (const s of SURFACES) {
      const [uLen, vLen] = surfaceDims(room, s);
      const patches = room.patches.filter((p) => p.surface === s).map((p) => Object.assign(clipPatch(room, p), { mat: p.type }));
      const patchArea = Math.min(uLen * vLen, patches.reduce((a, p) => a + p.area, 0));
      surf[s] = { base: room.surfaces[s], area: uLen * vLen, patchArea, patches };
      matKeys.add(room.surfaces[s]);
      patches.forEach((p) => matKeys.add(p.mat));
    }
    const lnB = {}, alpha = {};
    for (const key of matKeys) {
      lnB[key] = new Float64Array(nf);
      alpha[key] = new Float64Array(nf);
      for (let i = 0; i < nf; i++) {
        const a = Math.min(0.99, interpBands(MATERIALS[key].a, freqs[i]));
        alpha[key][i] = a;
        lnB[key][i] = 0.5 * Math.log(1 - a);
      }
    }

    const k = new Float64Array(nf), airHalf = new Float64Array(nf);
    const T60 = new Float64Array(nf), R = new Float64Array(nf), lateFrac = new Float64Array(nf);
    const absorption = new Float64Array(nf);
    const tc = ((order + 1) * ((4 * V) / S)) / C;
    for (let i = 0; i < nf; i++) {
      const f = freqs[i];
      k[i] = (TWO_PI * f) / C;
      const m = airAbsorption(f);
      airHalf[i] = m / 2;
      let A = room.people * interpBands(PERSON_ABS, f);
      for (const s of SURFACES) {
        const sf = surf[s];
        A += (sf.area - sf.patchArea) * alpha[sf.base][i];
        for (const p of sf.patches) A += p.area * alpha[p.mat][i];
      }
      absorption[i] = A;
      const am = Math.min(0.99, A / S);
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
                const cnt = Math.abs(l - p) + Math.abs(l) + Math.abs(m - q) + Math.abs(m) + Math.abs(n - r) + Math.abs(n);
                if (cnt > order) continue;
                images.push({ sx: 1 - 2 * p, sy: 1 - 2 * q, sz: 1 - 2 * r, ox: 2 * l * L, oy: 2 * m * W, oz: 2 * n * H, order: cnt });
              }

    const peak = Math.pow(10, LATE_PEAK_DB / 10);
    const typeData = {};
    for (const key of Object.keys(SPEAKER_TYPES)) {
      const qm1 = new Float64Array(nf), resp = new Float64Array(nf), late = new Float64Array(nf), qArr = new Float64Array(nf);
      for (let i = 0; i < nf; i++) {
        const q = speakerQ(key, freqs[i]);
        qArr[i] = q;
        qm1[i] = q - 1;
        resp[i] = speakerResp(key, freqs[i]);
        late[i] = ((16 * Math.PI) / (q * R[i])) * lateFrac[i] * peak;
      }
      typeData[key] = { qm1, resp, late, q: qArr };
    }

    const micCache = {};
    const ctx = {
      room, freqs, nf, k, airHalf, T60, R, lateFrac, absorption, images, typeData, V, S, order, surf, lnB, alpha,
      micResp(model, micHpf) {
        const key = model + '|' + micHpf;
        if (!micCache[key]) {
          const arr = new Float64Array(nf);
          for (let i = 0; i < nf; i++) arr[i] = micModelResp(model, freqs[i]) * (micHpf > 0 ? hpfMag(freqs[i], micHpf) : 1);
          micCache[key] = arr;
        }
        return micCache[key];
      },
      // 표면 위 한 점의 재질 → ln(반사계수) 배열
      lnBAt(s, x, y, z) {
        const sf = surf[s];
        if (sf.patches.length) {
          const [u, v] = toUV(s, x, y, z);
          for (const p of sf.patches) if (u >= p.u0 && u <= p.u1 && v >= p.v0 && v <= p.v1) return lnB[p.mat];
        }
        return lnB[sf.base];
      },
      freqIndex(f) {
        let b = 0;
        for (let i = 0; i < nf; i++) if (Math.abs(Math.log(freqs[i] / f)) < Math.abs(Math.log(freqs[b] / f))) b = i;
        return b;
      },
      bandT60(f0, f1) {
        let s = 0, n = 0;
        for (let i = 0; i < nf; i++) if (freqs[i] >= f0 && freqs[i] <= f1) { s += T60[i]; n++; }
        return n ? s / n : NaN;
      },
    };
    return ctx;
  }

  // 이미지 → 수음점 경로가 지나는 반사 지점들의 ln(반사계수) 배열 목록
  const AX_SURF = [['A', 'B'], ['C', 'D'], ['floor', 'ceil']];
  function collectReflections(ctx, ix, iy, iz, rx, ry, rz, out) {
    out.length = 0;
    const { L, W, H } = ctx.room;
    const dims = [L, W, H], I = [ix, iy, iz], Rr = [rx, ry, rz];
    for (let ax = 0; ax < 3; ax++) {
      const a = I[ax], b = Rr[ax], len = dims[ax];
      if (a >= 0 && a <= len) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const k0 = Math.floor(lo / len) + 1, k1 = Math.ceil(hi / len) - 1;
      for (let kk = k0; kk <= k1; kk++) {
        const plane = kk * len;
        if (plane <= lo || plane >= hi) continue;
        const t = (plane - a) / (b - a);
        const s = AX_SURF[ax][Math.abs(kk) % 2 === 0 ? 0 : 1];
        const px = fold(ix + t * (rx - ix), L), py = fold(iy + t * (ry - iy), W), pz = fold(iz + t * (rz - iz), H);
        out.push(ctx.lnBAt(s, px, py, pz));
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 스피커→마이크 전달
  function addPair(ctx, spk, mic, amp, micResp, re, im, late) {
    if (amp <= 0) return;
    const td = ctx.typeData[spk.type] || ctx.typeData.box;
    const sd = dirVec(spk.yaw, spk.pitch);
    const md = dirVec(mic.yaw, mic.pitch);
    const pattern = micPattern(mic);
    const a = micA(pattern);
    const nf = ctx.nf;
    const { k, airHalf } = ctx;
    const qm1 = td.qm1, resp = td.resp;
    const refl = [];

    for (let ii = 0; ii < ctx.images.length; ii++) {
      const img = ctx.images[ii];
      const ix = img.sx * spk.x + img.ox, iy = img.sy * spk.y + img.oy, iz = img.sz * spk.z + img.oz;
      const dx = mic.x - ix, dy = mic.y - iy, dz = mic.z - iz;
      let r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (r < 0.1) r = 0.1;
      const ux = dx / r, uy = dy / r, uz = dz / r;
      const cosS = ux * img.sx * sd[0] + uy * img.sy * sd[1] + uz * img.sz * sd[2];
      const lnBase = Math.log(Math.max(1e-9, (1 + cosS) / 2));
      const cosM = -(ux * md[0] + uy * md[1] + uz * md[2]);
      const pre = (amp * (a + (1 - a) * cosM)) / r;
      if (Math.abs(pre) < 1e-9) continue;
      if (img.order) collectReflections(ctx, ix, iy, iz, mic.x, mic.y, mic.z, refl);
      else refl.length = 0;
      const nr = refl.length, r0 = refl[0], r1 = refl[1], r2 = refl[2];
      for (let i = 0; i < nf; i++) {
        const g = (1 - REAR_FLOOR) * Math.exp(lnBase * qm1[i]) + REAR_FLOOR;
        let lnR = -airHalf[i] * r;
        if (nr > 0) lnR += r0[i];
        if (nr > 1) lnR += r1[i];
        if (nr > 2) lnR += r2[i];
        const A = pre * Math.sqrt(g) * Math.exp(lnR) * resp[i] * micResp[i];
        const ph = k[i] * r;
        re[i] += A * Math.cos(ph);
        im[i] -= A * Math.sin(ph);
      }
    }
    const ree = micREE(pattern);
    const lt = td.late;
    for (let i = 0; i < nf; i++) {
      const h = resp[i] * micResp[i];
      late[i] += amp * amp * h * h * lt[i] * ree;
    }
  }

  // ---------------------------------------------------------------- 루프 게인 평가
  function evaluate(ctx, speakers, mics, opts) {
    opts = opts || {};
    const lref = opts.lref == null ? 100 : opts.lref;
    const micHpf = opts.micHpf == null ? 100 : opts.micHpf;
    const nf = ctx.nf;
    const re = new Float64Array(nf), im = new Float64Array(nf), late = new Float64Array(nf);
    let nRouted = 0;
    for (const mic of mics) {
      const mr = ctx.micResp(mic.model, micHpf);
      for (const s of speakers) {
        if (!isRouted(s)) continue;
        const amp = speakerAmp(s, lref, opts && opts.taper);
        if (amp > 0) { nRouted++; addPair(ctx, s, mic, amp, mr, re, im, late); }
      }
    }
    const db = new Float64Array(nf), earlyDb = new Float64Array(nf), lateDb = new Float64Array(nf);
    let maxDb = -Infinity, iMax = 0;
    for (let i = 0; i < nf; i++) {
      const pe = re[i] * re[i] + im[i] * im[i];
      earlyDb[i] = 10 * Math.log10(pe + 1e-20);
      lateDb[i] = 10 * Math.log10(late[i] + 1e-20);
      db[i] = 10 * Math.log10(pe + late[i] + 1e-20);
      if (db[i] > maxDb) { maxDb = db[i]; iMax = i; }
    }
    return { freqs: ctx.freqs, db, earlyDb, lateDb, maxDb, fMax: ctx.freqs[iMax], iMax, margin: -maxDb, hasLoop: nRouted > 0 };
  }

  // 특정 주파수에서 각 (보컬 스피커, 마이크) 쌍의 기여도
  function pairContributions(ctx, speakers, mics, iFreq, opts) {
    const lref = (opts && opts.lref) == null ? 100 : opts.lref;
    const micHpf = (opts && opts.micHpf) == null ? 100 : opts.micHpf;
    const out = [];
    speakers.forEach((s, si) => {
      if (!isRouted(s)) return;
      mics.forEach((m, mi) => {
        const re = new Float64Array(ctx.nf), im = new Float64Array(ctx.nf), late = new Float64Array(ctx.nf);
        addPair(ctx, s, m, speakerAmp(s, lref, opts && opts.taper), ctx.micResp(m.model, micHpf), re, im, late);
        const p = re[iFreq] ** 2 + im[iFreq] ** 2 + late[iFreq];
        const g = geometry(s, m);
        out.push(Object.assign({ si, mi, db: 10 * Math.log10(p + 1e-20) }, g));
      });
    });
    return out;
  }

  // 스피커-마이크 사이 거리와 각도
  function geometry(s, m) {
    const dx = m.x - s.x, dy = m.y - s.y, dz = m.z - s.z;
    const r = Math.max(0.1, Math.hypot(dx, dy, dz));
    const sd = dirVec(s.yaw, s.pitch), md = dirVec(m.yaw, m.pitch);
    const spkAngle = Math.acos(Math.max(-1, Math.min(1, (dx * sd[0] + dy * sd[1] + dz * sd[2]) / r))) / DEG;
    const micAngle = Math.acos(Math.max(-1, Math.min(1, -(dx * md[0] + dy * md[1] + dz * md[2]) / r))) / DEG;
    return { dist: r, spkAngle, micAngle };
  }

  function peaks(result, withinDb, maxCount) {
    const { db, freqs } = result;
    const list = [];
    for (let i = 1; i < db.length - 1; i++) {
      if (db[i] >= db[i - 1] && db[i] >= db[i + 1] && db[i] >= result.maxDb - withinDb) list.push({ f: freqs[i], db: db[i] });
    }
    list.sort((a, b) => b.db - a.db);
    const out = [];
    for (const p of list) {
      if (out.every((q) => Math.abs(Math.log2(p.f / q.f)) > 1 / 3)) out.push(p);
      if (out.length >= (maxCount || 3)) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- 음압 / 블리드
  // 한 지점의 음압 (f Hz, 직접음 + 잔향음 에너지). 기준 입력(Lref) 대비 절대 음압.
  function splAt(ctx, speakers, pt, opts, f) {
    const lref = (opts && opts.lref) == null ? 100 : opts.lref;
    f = f || 2000;
    const i = ctx.freqIndex(f);
    const R = ctx.R[i];
    let D = 0, Rv = 0;
    for (const s of speakers) {
      const amp = speakerAmp(s, lref, opts && opts.taper);
      if (amp <= 0) continue;
      const q = speakerQ(s.type, f);
      const h = speakerResp(s.type, f);
      const sd = dirVec(s.yaw, s.pitch);
      const dx = pt.x - s.x, dy = pt.y - s.y, dz = pt.z - s.z;
      const r = Math.max(0.3, Math.hypot(dx, dy, dz));
      const cosS = (dx * sd[0] + dy * sd[1] + dz * sd[2]) / r;
      const g = (1 - REAR_FLOOR) * Math.pow((1 + cosS) / 2, q - 1) + REAR_FLOOR;
      D += (amp * amp * h * h * g) / (r * r);
      Rv += (amp * amp * h * h * 16 * Math.PI) / (q * R);
    }
    return { spl: 10 * Math.log10(D + Rv + 1e-20) + lref, dr: 10 * Math.log10((D + 1e-20) / (Rv + 1e-20)) };
  }

  function coverage(ctx, speakers, pts, opts, f) {
    if (!pts.length || !speakers.length) return { meanSpl: NaN, stdSpl: 0, meanDR: 0, n: 0 };
    let sum = 0, sum2 = 0, drSum = 0;
    for (const p of pts) {
      const r = splAt(ctx, speakers, p, opts, f);
      sum += r.spl; sum2 += r.spl * r.spl; drSum += Math.max(-15, Math.min(15, r.dr));
    }
    const n = pts.length, mean = sum / n;
    return { meanSpl: mean, stdSpl: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), meanDR: drSum / n, n };
  }

  // 악기 앰프 소리가 보컬 마이크로 새어 드는 양 (보컬 기준 입력 대비 dB, 1 kHz)
  function bleed(ctx, speakers, mics, opts) {
    const lref = (opts && opts.lref) == null ? 100 : opts.lref;
    const f = 1000, i = ctx.freqIndex(f), R = ctx.R[i];
    let worst = -Infinity;
    const per = [];
    mics.forEach((m, mi) => {
      const pattern = micPattern(m), a = micA(pattern), ree = micREE(pattern);
      const md = dirVec(m.yaw, m.pitch);
      let tot = 0;
      speakers.forEach((s, si) => {
        if (isRouted(s)) return;
        const amp = speakerAmp(s, lref, opts && opts.taper);
        if (amp <= 0) return;
        const q = speakerQ(s.type, f), h = speakerResp(s.type, f);
        const sd = dirVec(s.yaw, s.pitch);
        const dx = m.x - s.x, dy = m.y - s.y, dz = m.z - s.z;
        const r = Math.max(0.3, Math.hypot(dx, dy, dz));
        const cosS = (dx * sd[0] + dy * sd[1] + dz * sd[2]) / r;
        const g = (1 - REAR_FLOOR) * Math.pow((1 + cosS) / 2, q - 1) + REAR_FLOOR;
        const cosM = -(dx * md[0] + dy * md[1] + dz * md[2]) / r;
        const mr = a + (1 - a) * cosM;
        const e = amp * amp * h * h * ((g * mr * mr) / (r * r) + ((16 * Math.PI) / (q * R)) * ree);
        tot += e;
        per.push({ si, mi, db: 10 * Math.log10(e + 1e-20) });
      });
      if (tot > 0) worst = Math.max(worst, 10 * Math.log10(tot));
    });
    per.sort((x, y) => y.db - x.db);
    return { db: worst, per };
  }

  // 인원 위치 (보컬은 첫 번째 마이크를 따라감)
  function resolvePeople(people, mics) {
    return (people || []).map((p) => {
      if (p.vocal && mics[0]) {
        const d = dirVec(mics[0].yaw, 0);
        return { x: mics[0].x + d[0] * 0.12, y: mics[0].y + d[1] * 0.12, z: p.z || 1.6, vocal: true, name: p.name };
      }
      return { x: p.x, y: p.y, z: p.z || 1.5, vocal: false, name: p.name };
    });
  }

  // ---------------------------------------------------------------- 점수
  function score(m, opts) {
    const req = opts.reqMargin == null ? 6 : opts.reqMargin;
    const w = opts.weight == null ? 0.4 : opts.weight;
    const margin = Math.min(m.margin, 100);
    const stab = margin < req ? req + 3 * (margin - req) : req + 0.6 * Math.min(10, margin - req);
    const cv = m.cov && m.cov.n ? -m.cov.stdSpl + 0.4 * m.cov.meanDR : 0;
    const bl = Number.isFinite(m.bleed) ? -0.25 * Math.max(m.bleed, -35) : 0;
    const bd = m.band && m.band.n ? -0.5 * m.band.stdSpl : 0;
    return (1 - w) * stab + w * 1.5 * cv + bl + bd + (m.penalty || 0);
  }

  // ---------------------------------------------------------------- 벽 둘레 좌표
  const WALL_OFFSET = 0.2; // 벽에서 스피커 중심까지 (캐비닛 깊이의 절반 정도)
  const CORNER_GAP = 0.35; // 모서리에서 최소 간격

  // 둘레 좌표 t (C벽 → B벽 → D벽 → A벽, 반시계) → 위치와 벽 법선 방향
  function perimeterToPose(room, t) {
    const { L, W } = room;
    const P = 2 * (L + W);
    t = ((t % P) + P) % P;
    const along = (s, len) => Math.max(Math.min(CORNER_GAP, len / 2), Math.min(len - Math.min(CORNER_GAP, len / 2), s));
    if (t < L) return { x: along(t, L), y: WALL_OFFSET, yaw: 90, wall: 'C' };
    if (t < L + W) return { x: L - WALL_OFFSET, y: along(t - L, W), yaw: 180, wall: 'B' };
    if (t < 2 * L + W) return { x: along(L - (t - L - W), L), y: W - WALL_OFFSET, yaw: -90, wall: 'D' };
    return { x: WALL_OFFSET, y: along(W - (t - 2 * L - W), W), yaw: 0, wall: 'A' };
  }
  function poseToPerimeter(room, x, y) {
    const { L, W } = room;
    const d = [y, L - x, W - y, x]; // C, B, D, A
    const w = d.indexOf(Math.min(...d));
    if (w === 0) return { t: x, normal: 90 };
    if (w === 1) return { t: L + y, normal: 180 };
    if (w === 2) return { t: L + W + (L - x), normal: -90 };
    return { t: 2 * L + W + (W - y), normal: 0 };
  }
  const normYaw = (y) => { y = (((y + 180) % 360) + 360) % 360 - 180; return y === -180 ? 180 : y; };
  function nearestWall(room, x, y) {
    const d = { C: y, B: room.L - x, D: room.W - y, A: x };
    return Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
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
  const cloneCfg = (cfg) => ({ speakers: cfg.speakers.map((s) => ({ ...s })), mics: cfg.mics.map((m) => ({ ...m })) });

  function buildParams(room, cfg, o) {
    const params = [];
    const { L, W, H } = room;
    const P = 2 * (L + W);
    cfg.speakers.forEach((s, i) => {
      const routed = isRouted(s);
      if (!((routed && o.optPA) || (!routed && o.optInst))) return;
      const S = (key) => ({ get: (c) => c.speakers[i][key], set: (c, v) => { c.speakers[i][key] = v; } });
      if (s.type === 'ceiling') {
        params.push({ ...S('x'), lo: 0.3, hi: L - 0.3, kind: 'pos' });
        params.push({ ...S('y'), lo: 0.3, hi: W - 0.3, kind: 'pos' });
        return;
      }
      // 벽에 붙여 배치: 둘레 좌표 + 벽 법선 대비 각도
      params.push({
        get: (c) => poseToPerimeter(room, c.speakers[i].x, c.speakers[i].y).t,
        set: (c, v) => { c.speakers[i]._t = v; },
        lo: 0, hi: P, circ: true, kind: 'pos',
      });
      params.push({
        get: (c) => { const n = poseToPerimeter(room, c.speakers[i].x, c.speakers[i].y).normal; return Math.max(-40, Math.min(40, normYaw(c.speakers[i].yaw - n))); },
        set: (c, v) => { c.speakers[i]._toe = v; },
        lo: -40, hi: 40, kind: 'ang',
      });
      if (routed) {
        params.push({ ...S('z'), lo: Math.min(1.5, H - 0.6), hi: H - 0.25, kind: 'pos' });
        params.push({ ...S('pitch'), lo: -45, hi: 15, kind: 'ang' });
      } else {
        params.push({ ...S('z'), lo: 0.25, hi: Math.min(0.8, H - 0.3), kind: 'pos' });
        params.push({ ...S('pitch'), lo: 0, hi: 40, kind: 'ang' });
      }
    });
    if (o.optMic) {
      const mx = Math.min(0.5, L / 4), my = Math.min(0.5, W / 4);
      cfg.mics.forEach((m, i) => {
        const M = (key) => ({ get: (c) => c.mics[i][key], set: (c, v) => { c.mics[i][key] = v; } });
        params.push({ ...M('x'), lo: mx, hi: L - mx, kind: 'pos' });
        params.push({ ...M('y'), lo: my, hi: W - my, kind: 'pos' });
        params.push({ ...M('yaw'), lo: -180, hi: 180, circ: true, kind: 'ang' });
      });
    }
    return params;
  }

  function finalizeCfg(room, c) {
    for (const s of c.speakers) {
      if (s._t == null) continue;
      const pose = perimeterToPose(room, s._t);
      s.x = pose.x; s.y = pose.y;
      s.yaw = normYaw(pose.yaw + (s._toe || 0));
      delete s._t; delete s._toe;
    }
    return c;
  }

  function clampParam(p, v) {
    if (p.circ) {
      const span = p.hi - p.lo;
      return ((((v - p.lo) % span) + span) % span) + p.lo;
    }
    return Math.max(p.lo, Math.min(p.hi, v));
  }

  // 물리적으로 겹치는 배치에 대한 벌점
  function penalties(c, people) {
    let pen = 0;
    const others = people.filter((p) => !p.vocal);
    for (const m of c.mics) {
      for (const p of others) { const d = Math.hypot(m.x - p.x, m.y - p.y); if (d < 0.8) pen -= 6 * (0.8 - d); }
      for (const s of c.speakers) { const d = Math.hypot(m.x - s.x, m.y - s.y); if (d < 0.8) pen -= 6 * (0.8 - d); }
    }
    for (let i = 0; i < c.speakers.length; i++)
      for (let j = i + 1; j < c.speakers.length; j++) {
        const a = c.speakers[i], b = c.speakers[j];
        if (Math.abs(a.z - b.z) > 0.7) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 0.6) pen -= 8 * (0.6 - d);
      }
    for (const s of c.speakers) for (const p of others) { const d = Math.hypot(s.x - p.x, s.y - p.y); if (d < 0.4) pen -= 4 * (0.4 - d); }
    // 보컬은 다른 멤버들 쪽을 바라보도록 (보컬이 바라보는 방향 = 마이크가 향하는 방향의 반대)
    const voc = people.find((p) => p.vocal);
    if (voc && others.length && c.mics[0]) {
      const cx = others.reduce((a, p) => a + p.x, 0) / others.length - voc.x;
      const cy = others.reduce((a, p) => a + p.y, 0) / others.length - voc.y;
      if (Math.hypot(cx, cy) > 0.3) {
        const face = dirVec(c.mics[0].yaw + 180, 0);
        const ang = Math.acos(Math.max(-1, Math.min(1, (face[0] * cx + face[1] * cy) / Math.hypot(cx, cy)))) / DEG;
        if (ang > 70) pen -= 0.12 * (ang - 70);
      }
    }
    return pen;
  }

  function measureCfg(ctx, c, peopleDef, o) {
    const r = evaluate(ctx, c.speakers, c.mics, o);
    const pts = resolvePeople(peopleDef, c.mics);
    const routed = c.speakers.filter(isRouted), inst = c.speakers.filter((s) => !isRouted(s));
    const cov = coverage(ctx, routed, pts, o);
    const bl = bleed(ctx, c.speakers, c.mics, o).db;
    const band = o.optInst ? coverage(ctx, inst, pts.filter((p) => !p.vocal), o, 1000) : null;
    return { margin: r.margin, cov, bleed: bl, band, penalty: penalties(c, pts) };
  }

  /**
   * 점진적 최적화기. step(ms)를 반복 호출 (UI 비차단).
   * cfg0: { speakers, mics, people }
   * options: { optPA, optInst, optMic, weight, reqMargin, lref, micHpf, seed, nRandom, nStarts, iters }
   * 스피커(PA·악기 앰프)는 항상 벽에 붙여 배치한다. 천장형은 천장에 붙인다.
   */
  function createOptimizer(room, cfg0, options) {
    const o = Object.assign(
      { optPA: true, optInst: false, optMic: true, weight: 0.4, reqMargin: 6, lref: 100, micHpf: 100, order: 2, seed: 12345 },
      options || {}
    );
    room = normalizeRoom(room);
    const base = cloneCfg(cfg0);
    const peopleDef = cfg0.people || [];
    const params = buildParams(room, base, o);
    const small = params.length <= 4;
    o.nRandom = o.nRandom || (small ? 300 : 500);
    o.nStarts = o.nStarts || (small ? 4 : 6);
    o.iters = o.iters || (small ? 150 : 220);

    const rng = mulberry32(o.seed);
    const gauss = () => {
      let u = 0, v = 0;
      while (u === 0) u = rng();
      while (v === 0) v = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
    };
    const ctxFast = prepare(room, { perOct: 24, order: o.order });
    const ctxFine = prepare(room, { perOct: 48, order: o.order });

    const decode = (vec) => {
      const c = cloneCfg(base);
      params.forEach((p, i) => p.set(c, vec[i]));
      return finalizeCfg(room, c);
    };
    const evalVec = (vec, ctx) => {
      const m = measureCfg(ctx, decode(vec), peopleDef, o);
      m.s = score(m, o);
      return m;
    };
    const cur = params.map((p) => p.get(base));
    const curClamped = params.map((p, i) => clampParam(p, cur[i]));

    const pool = [];
    let phase = 'random', iRand = 0, iStart = 0, iIter = 0, evals = 0;
    let local = null;
    const finalists = [];
    let result = null;
    const totalWork = o.nRandom + o.nStarts * o.iters + 1;
    const randomVec = () => params.map((p) => p.lo + (p.hi - p.lo) * rng());

    function stepOnce() {
      if (phase === 'random') {
        const vec = iRand === 0 ? curClamped.slice() : randomVec();
        pool.push({ vec, s: evalVec(vec, ctxFast).s });
        evals++;
        if (++iRand >= o.nRandom) { pool.sort((a, b) => b.s - a.s); phase = 'local'; }
        return;
      }
      if (phase === 'local') {
        if (!local) {
          const starts = [];
          for (const c of pool) {
            if (starts.length >= o.nStarts) break;
            const diff = starts.every((s) => params.some((p, i) => p.kind === 'pos' && Math.abs(s.vec[i] - c.vec[i]) > 0.6));
            if (diff || starts.length === 0) starts.push(c);
          }
          while (starts.length < o.nStarts) starts.push(pool[starts.length]);
          local = { starts, cur: null };
        }
        if (!local.cur) { local.cur = { vec: local.starts[iStart].vec.slice(), s: local.starts[iStart].s }; iIter = 0; }
        const t = iIter / o.iters;
        const sigma = 0.2 * (1 - t) + 0.015;
        const cand = local.cur.vec.slice();
        const nChange = 1 + Math.floor(rng() * Math.min(3, params.length));
        for (let c = 0; c < nChange; c++) {
          const i = Math.floor(rng() * params.length);
          const p = params[i];
          const span = p.circ && p.kind === 'pos' ? Math.min(p.hi - p.lo, 2 * (room.L + room.W) * 0.35) : p.hi - p.lo;
          cand[i] = clampParam(p, cand[i] + gauss() * sigma * span);
        }
        const e = evalVec(cand, ctxFast);
        evals++;
        if (e.s >= local.cur.s) local.cur = { vec: cand, s: e.s };
        if (++iIter >= o.iters) {
          finalists.push(local.cur);
          local.cur = null;
          if (++iStart >= local.starts.length) phase = 'final';
        }
        return;
      }
      if (phase === 'final') {
        // 정밀 주파수 격자 + 위치 오차(±10 cm, ±5°)에 대한 강건성
        finalists.push({ vec: curClamped.slice(), isCurrent: true });
        let best = null;
        for (const f of finalists) {
          const nominal = evalVec(f.vec, ctxFine);
          let worst = nominal.margin;
          for (let j = 0; j < 4; j++) {
            const jv = f.vec.map((v, i) => clampParam(params[i], v + (params[i].kind === 'pos' ? 0.1 : 5) * gauss()));
            worst = Math.min(worst, evalVec(jv, ctxFine).margin);
          }
          const robustMargin = Math.min(nominal.margin, worst + 1.5);
          const s = score(Object.assign({}, nominal, { margin: robustMargin }), o);
          const entry = { vec: f.vec, s, nominal, robustMargin, isCurrent: !!f.isCurrent };
          if (!best || entry.s > best.s + 1e-9) best = entry;
        }
        const before = measureCfg(ctxFine, cloneCfg(base), peopleDef, o);
        result = {
          config: decode(best.vec),
          margin: best.nominal.margin,
          robustMargin: best.robustMargin,
          coverage: best.nominal.cov,
          bleed: best.nominal.bleed,
          keptCurrent: best.isCurrent,
          before: { margin: before.margin, coverage: before.cov, bleed: before.bleed },
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
      runSync() { while (phase !== 'done') stepOnce(); return result; },
    };
  }

  // ---------------------------------------------------------------- 흡음재 추천
  // 1차 반사 지점: 스피커를 표면에 대해 거울상으로 옮긴 뒤 마이크와 잇는 직선이 표면과 만나는 점
  function firstReflectionPoint(room, s, spk, mic) {
    const { L, W, H } = room;
    const img = { x: spk.x, y: spk.y, z: spk.z };
    let ax, plane;
    switch (s) {
      case 'A': ax = 'x'; plane = 0; break;
      case 'B': ax = 'x'; plane = L; break;
      case 'C': ax = 'y'; plane = 0; break;
      case 'D': ax = 'y'; plane = W; break;
      case 'floor': ax = 'z'; plane = 0; break;
      default: ax = 'z'; plane = H;
    }
    img[ax] = 2 * plane - spk[ax];
    const d = mic[ax] - img[ax];
    if (Math.abs(d) < 1e-9) return null;
    const t = (plane - img[ax]) / d;
    if (t <= 0 || t >= 1) return null;
    const P = { x: img.x + t * (mic.x - img.x), y: img.y + t * (mic.y - img.y), z: img.z + t * (mic.z - img.z) };
    const [u, v] = toUV(s, P.x, P.y, P.z);
    const [uLen, vLen] = surfaceDims(room, s);
    if (u < 0 || u > uLen || v < 0 || v > vLen) return null;
    // 경로 세기: 스피커 지향성(2 kHz) × 마이크 감도 / 경로 길이
    const sd = dirVec(spk.yaw, spk.pitch);
    const r1 = Math.max(0.1, Math.hypot(P.x - spk.x, P.y - spk.y, P.z - spk.z));
    const r2 = Math.max(0.1, Math.hypot(mic.x - P.x, mic.y - P.y, mic.z - P.z));
    const cosS = ((P.x - spk.x) * sd[0] + (P.y - spk.y) * sd[1] + (P.z - spk.z) * sd[2]) / r1;
    const q = speakerQ(spk.type, 2000);
    const g = (1 - REAR_FLOOR) * Math.pow((1 + cosS) / 2, q - 1) + REAR_FLOOR;
    const md = dirVec(mic.yaw, mic.pitch);
    const cosM = ((P.x - mic.x) * md[0] + (P.y - mic.y) * md[1] + (P.z - mic.z) * md[2]) / r2;
    const a = micA(micPattern(mic));
    const weight = (Math.sqrt(g) * Math.abs(a + (1 - a) * cosM)) / (r1 + r2);
    return { u, v, weight, point: P };
  }

  function rectOverlap(a, b) {
    const w = Math.max(0, Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0));
    const h = Math.max(0, Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0));
    return w * h;
  }

  /**
   * 흡음재 추천 (탐욕적 단계 탐색).
   * 각 단계마다 "표면 × 흡음재 종류 × 크기 × 위치(1차 반사 지점·중앙·모서리)" 후보를 시뮬레이션해
   * 하울링 여유와 잔향시간 목표(합주실 0.3–0.45 s)를 가장 효율적으로(면적 대비) 개선하는 것을 고른다.
   * options: { budget (m²), reqMargin, lref, micHpf, rtLo, rtHi, minGain, maxSteps }
   *  - room0.patches(이미 붙인 흡음재)는 그대로 두고 그 위에 추가한다. 따라서 이전 추천 결과를 patches에
   *    넣고 budget만 새로 주면 "다음으로 좋은 곳"에 이어서 추가하는 용도로 쓸 수 있다.
   *  - minGain: 한 단계로 인정할 최소 개선 점수 (기본 0.2, 추가 모드에서는 작게 — 효과가 조금이라도 있으면 배치)
   */
  function createAbsorberPlanner(room0, speakers, mics, options) {
    const o = Object.assign({ budget: 10, reqMargin: 6, lref: 100, micHpf: 100, rtLo: 0.28, rtHi: 0.45, minGain: 0.2, maxSteps: 12 }, options || {});
    const room = normalizeRoom(room0);
    room.patches = room.patches.map((p) => ({ ...p }));
    const routed = speakers.filter((s) => isRouted(s) && speakerAmp(s, o.lref, o.taper) > 0);

    function measure(r) {
      const ctx = prepare(r, { perOct: 24 });
      const ev = evaluate(ctx, speakers, mics, o);
      const rtMid = ctx.bandT60(400, 1300), rtLow = ctx.bandT60(100, 280), rtHigh = ctx.bandT60(2000, 5000);
      const margin = ev.hasLoop ? ev.margin : Infinity;
      let s = Math.min(margin, o.reqMargin + 8);
      s -= 8 * Math.max(0, rtMid - o.rtHi) + 10 * Math.max(0, o.rtLo - rtMid);
      s -= 4 * Math.max(0, rtLow - 1.6 * rtMid);
      s -= 6 * Math.max(0, o.rtLo * 0.8 - rtHigh);
      return { s, margin, rtMid, rtLow, rtHigh };
    }

    function candidates(r) {
      const out = [];
      const H = r.H;
      const add = (surface, type, u, v, w, h, reason) => {
        const cp = clipPatch(r, { surface, u, v, w, h });
        if (cp.area < 0.2) return;
        const cand = { surface, type, u: cp.u, v: cp.v, w: cp.w, h: cp.h, area: cp.area, reason };
        // 이미 붙인 흡음재와 많이 겹치면 제외
        for (const p of r.patches) {
          if (p.surface !== surface) continue;
          const q = clipPatch(r, p);
          if (rectOverlap(cp, q) > 0.3 * cp.area) return;
        }
        out.push(cand);
      };
      for (const s of SURFACES) {
        const [uLen, vLen] = surfaceDims(r, s);
        // 1차 반사 지점 (보컬 스피커 → 마이크)
        const spots = [];
        routed.forEach((spk) => mics.forEach((mic) => {
          const fr = firstReflectionPoint(r, s, spk, mic);
          if (fr) spots.push(Object.assign(fr, { spk, mic }));
        }));
        spots.sort((a, b) => b.weight - a.weight);
        const picks = [];
        for (const sp of spots) {
          if (picks.every((p) => Math.hypot(p.u - sp.u, p.v - sp.v) > 0.8)) picks.push(sp);
          if (picks.length >= 2) break;
        }
        const positions = picks.map((p) => ({ u: p.u, v: p.v, reason: { kind: 'reflection', spk: p.spk, mic: p.mic } }));
        const isWall = s !== 'floor' && s !== 'ceil';
        positions.push({ u: uLen / 2, v: isWall ? Math.min(1.5, vLen / 2) : vLen / 2, reason: { kind: 'general' } });
        for (const pos of positions) {
          if (isWall) {
            for (const type of ['panel50', 'panel100', 'foam25'])
              for (const [w, h] of [[0.6, 1.2], [1.2, 1.2], [2.4, 1.2], [3.6, 1.2]]) add(s, type, pos.u, pos.v, w, h, pos.reason);
            for (const w of [2, 3]) add(s, 'curtain', pos.u, (H - 0.2) / 2 + 0.1, w, H - 0.2, pos.reason);
          } else if (s === 'ceil') {
            for (const type of ['panel50', 'panel100'])
              for (const [w, h] of [[1.2, 0.6], [1.2, 1.2], [2.4, 1.2], [2.4, 2.4]]) add(s, type, pos.u, pos.v, w, h, pos.reason);
          } else {
            for (const [w, h] of [[2, 1.5], [3, 2]]) add(s, 'carpet', pos.u, pos.v, w, h, pos.reason);
          }
        }
      }
      // 수직 모서리 베이스트랩 (A/B벽의 양 끝)
      for (const s of ['A', 'B'])
        for (const u of [0.3, r.W - 0.3]) add(s, 'basstrap', u, H / 2, 0.6, H, { kind: 'corner', other: u < r.W / 2 ? 'C' : 'D' });
      return out;
    }

    const steps = [];
    const start = measure(room);
    let curM = start;
    let used = 0;
    let finished = false;

    function step() {
      if (finished) return true;
      let best = null;
      for (const c of candidates(room)) {
        if (used + c.area > o.budget + 1e-9) continue;
        const trial = Object.assign({}, room, { patches: room.patches.concat([{ surface: c.surface, type: c.type, u: c.u, v: c.v, w: c.w, h: c.h }]) });
        const m = measure(trial);
        const gain = m.s - curM.s;
        const eff = gain / Math.pow(c.area, 0.6);
        if (gain > o.minGain && (!best || eff > best.eff)) best = { c, m, gain, eff };
      }
      if (!best || steps.length >= o.maxSteps) { finished = true; return true; }
      room.patches.push({ surface: best.c.surface, type: best.c.type, u: best.c.u, v: best.c.v, w: best.c.w, h: best.c.h });
      used += best.c.area;
      steps.push(Object.assign({}, best.c, {
        before: { margin: curM.margin, rtMid: curM.rtMid, rtLow: curM.rtLow },
        after: { margin: best.m.margin, rtMid: best.m.rtMid, rtLow: best.m.rtLow },
      }));
      curM = best.m;
      return false;
    }

    return {
      step,
      get done() { return finished; },
      get progress() { return finished ? 1 : Math.min(0.95, used / o.budget); },
      get result() {
        return { steps, start, end: curM, usedArea: used, patches: room.patches };
      },
      runSync() { while (!step()); return this.result; },
    };
  }

  const api = {
    C, BANDS, MATERIALS, ABSORBERS, SURFACES, SURFACE_NAMES, SPEAKER_TYPES, SPEAKER_MODELS, MIC_PATTERNS, MIC_MODELS,
    LATE_PEAK_DB, PANEL_AREA, WALL_OFFSET,
    freqGrid, interpBands, speakerQ, speakerHalfAngle, speakerAmp, speakerResp, volumeDb, speakerLevel1m, volumeForDelta, micPattern, micA, micREE, micNullAngle,
    micModelResp, dirVec, isRouted, normalizeRoom, surfaceDims, toUV, fromUV, clipPatch,
    prepare, evaluate, pairContributions, geometry, peaks, splAt, coverage, bleed, resolvePeople, score,
    perimeterToPose, poseToPerimeter, nearestWall, createOptimizer, firstReflectionPoint, createAbsorberPlanner, collectReflections,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Acoustics = api;
})(typeof window !== 'undefined' ? window : globalThis);
