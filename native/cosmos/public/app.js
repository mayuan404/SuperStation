'use strict';

/**
 * app.js —— Local Cosmos 渲染层。
 *
 * 世界结构：宇宙 → 星系（用户指定的目录）→ 星云（一级子目录）→ 星（文件）
 * 颜色编码：星体的「年龄」。刚改过的是蓝白色的年轻恒星，多年未动的是橙红色的老年恒星。
 */

(() => {
  const canvas = document.getElementById('sky');
  const ctx = canvas.getContext('2d', { alpha: false });
  const $ = (id) => document.getElementById(id);

  const GOLDEN = 2.399963229728653;
  const DAY = 86400000;
  const MAX_PER_NEBULA = 4200;

  /* ---------------------------------------------------------- 色温 */

  // 年龄 → 色温：冷蓝（新）→ 白 → 琥珀 → 锈红（旧）
  const AGE_STOPS = [
    [0.00, [146, 198, 255]],
    [0.28, [206, 224, 244]],
    [0.62, [236, 170, 118]],
    [1.00, [186, 92, 70]]
  ];
  const BUCKETS = 14;
  const BUCKET_COLORS = Array.from({ length: BUCKETS }, (_, i) => {
    const t = i / (BUCKETS - 1);
    return `rgb(${ageColor(t).join(',')})`;
  });
  const BUCKET_COLORS_HI = Array.from({ length: BUCKETS }, (_, i) => {
    const t = i / (BUCKETS - 1);
    return `rgb(${ageColor(t).map((c) => Math.min(255, c * 1.5)).join(',')})`;
  });

  function ageColor(t) {
    for (let i = 1; i < AGE_STOPS.length; i++) {
      if (t <= AGE_STOPS[i][0]) {
        const [t0, c0] = AGE_STOPS[i - 1];
        const [t1, c1] = AGE_STOPS[i];
        const k = (t - t0) / (t1 - t0 || 1);
        return c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
      }
    }
    return AGE_STOPS[AGE_STOPS.length - 1][1];
  }

  /** 时间归一化：0 = 今天，1 = 三年以上 */
  function ageT(ms, now) {
    const days = Math.max(0, (now - ms) / DAY);
    return Math.min(1, Math.log1p(days) / Math.log1p(1095));
  }

  const ageBucket = (t) => Math.min(BUCKETS - 1, Math.round(t * (BUCKETS - 1)));

  /* ---------------------------------------------------------- 状态 */

  const U = {
    w: 0, h: 0, dpr: 1,
    galaxies: [],
    cores: [],
    nebulas: [],
    stars: [],
    cam: { x: 0, y: 0, z: 1 },
    target: null,
    hover: null,
    selected: null,
    query: '',
    matches: 0,
    loaded: false,
    gain: Number(localStorage.getItem('cosmos.gain')) || 1,
    t0: performance.now()
  };

  let dirty = true;
  const markDirty = () => { dirty = true; };

  /* ---------------------------------------------------------- 小工具 */

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const normLog = (v, max) => (max <= 1 ? 0 : Math.log10(Math.max(1, v)) / Math.log10(Math.max(2, max)));

  let HOME_PATH = null;

  function fmtSize(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    const v = b / Math.pow(1024, i);
    return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  }

  function fmtDate(ms) {
    const d = new Date(ms);
    const now = Date.now();
    const days = (now - ms) / DAY;
    if (days < 1) return '今天 ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    if (days < 30) return Math.floor(days) + ' 天前';
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }

  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function strSeed(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, 2200);
    setTimeout(() => el.remove(), 2800);
  }

  /* ---------------------------------------------------------- 数据加载 */

  async function api(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  function storedRoots() {
    try { return JSON.parse(localStorage.getItem('cosmos.roots') || '[]'); } catch { return []; }
  }
  function storeRoots(list) {
    localStorage.setItem('cosmos.roots', JSON.stringify(list));
  }

  async function addGalaxy(p, opts = {}) {
    const existing = U.galaxies.find((g) => g.root === p);
    if (existing && !opts.refresh) return existing;

    showLoading(`正在巡天 · ${p}`);
    try {
      const data = await api(`/api/galaxy?path=${encodeURIComponent(p)}${opts.refresh ? '&refresh=1' : ''}`);
      if (existing) {
        U.galaxies[U.galaxies.indexOf(existing)] = data;
      } else {
        U.galaxies.push(data);
      }
      storeRoots(U.galaxies.map((g) => g.root));
      U.loaded = true;
      if (!data.stats.files) toast(`「${data.label}」里没有能扫描的文件`);
      rebuild();
      updateStats();
      renderBars();
      if (opts.focus !== false) fitAll();
      return data;
    } finally {
      hideLoading();
      markDirty();
    }
  }

  async function removeGalaxy(root) {
    await api(`/api/galaxy?path=${encodeURIComponent(root)}`, { method: 'DELETE' }).catch(() => {});
    U.galaxies = U.galaxies.filter((g) => g.root !== root);
    storeRoots(U.galaxies.map((g) => g.root));
    if (!U.galaxies.length) { U.loaded = false; showPicker(); }
    rebuild();
    updateStats();
    renderBars();
    fitAll();
  }

  /* ---------------------------------------------------------- 布局 */

  function pickFiles(files, limit) {
    if (files.length <= limit) return files;
    // 大文件全保留（它们是星图上最亮的恒星），其余等距抽样
    const sorted = files.slice().sort((a, b) => b.s - a.s);
    const head = sorted.slice(0, Math.min(600, Math.floor(limit * 0.3)));
    const rest = sorted.slice(head.length);
    const keep = limit - head.length;
    const step = rest.length / keep;
    const out = head.slice();
    for (let i = 0; i < keep; i++) out.push(rest[Math.floor(i * step)]);
    return out;
  }

  function rebuild() {
    const now = Date.now();
    U.stars = [];
    U.nebulas = [];
    U.cores = [];
    U.starSystems = [];

    // 空目录不占星系位置，否则它会把视野中心推到空旷处
    const gs = U.galaxies.filter((g) => g.stats.files > 0);
    if (!gs.length) return;

    const maxGal = Math.max(1, ...gs.map((g) => g.stats.totalSize));
    const sizes = gs.map((g) => 320 + 660 * Math.pow(g.stats.totalSize / maxGal, 0.4));
    const gRmax = Math.max(...sizes);
    const n = gs.length;
    const ringR = n === 1 ? 0 : (1.22 * gRmax) / Math.sin(Math.PI / n);
    const TAU = Math.PI * 2;

    gs.forEach((g, gi) => {
      const ang = -Math.PI / 2 + (gi / n) * TAU;
      const gx = Math.cos(ang) * ringR;
      const gy = Math.sin(ang) * ringR;
      const gR = sizes[gi];

      const nebs = g.nebulas.filter((nb) => nb.count > 0);

      // ---- 每个星系的形态都不同，由它的路径哈希稳定决定 ----
      // 真实宇宙里没有两个星系长得一样：有的双旋臂，有的单臂，有的干脆是一团。
      const rnd = mulberry(strSeed(g.root) ^ 0x9e3779b9);
      const roll = rnd();

      // 臂数、缠绕度、倾角都随机：单臂 / 双臂 / 三臂，扁的圆的，每个星系不一样
      let armCount = 1;
      if (nebs.length >= 6) armCount = roll < 0.42 ? 1 : roll < 0.86 ? 2 : 3;
      else if (nebs.length >= 3) armCount = roll < 0.55 ? 1 : 2;

      // 倾角：把星系盘压扁一点，看起来像从侧面看过去
      const tiltAngle = rnd() * TAU;
      const squash = 0.48 + rnd() * 0.5;
      const cosT = Math.cos(tiltAngle);
      const sinT = Math.sin(tiltAngle);
      const place = (dx, dy) => [
        dx * cosT - dy * sinT,
        (dx * sinT + dy * cosT) * squash
      ];

      const arms = [];
      for (let a = 0; a < armCount; a++) {
        arms.push({
          phase: (a * TAU) / armCount + (rnd() - 0.5) * 1.1,
          turn: (1.15 + rnd() * 1.5) * Math.PI,
          uMax: 0.82 + rnd() * 0.23
        });
      }

      const warpPhase = rnd() * TAU;
      const wobble = (u) => Math.sin(u * 6.1 + warpPhase) * 0.055 + Math.sin(u * 14.3 + warpPhase * 1.7) * 0.022;
      const radiusAt = (u) => gR * (0.16 * Math.pow(1 / 0.16, clamp(u, 0, 1))) * (1 + wobble(u * 1.3));

      U.cores.push({
        x: gx, y: gy, r: gR, name: g.label, root: g.root,
        size: g.stats.totalSize, count: g.stats.files
      });

      // 核球
      const allFiles = [];
      for (const nb of nebs) {
        const step = Math.max(1, Math.floor(nb.files.length / 130));
        for (let i = 0; i < nb.files.length && allFiles.length < 800; i += step) allFiles.push(nb.files[i]);
      }
      const bulgeRand = mulberry(strSeed(g.root) + 31);
      for (let i = 0; i < allFiles.length; i++) {
        const a = bulgeRand() * TAU;
        const rad = Math.abs(bulgeRand() + bulgeRand() + bulgeRand() - 1.5) * gR * 0.24;
        const [ox, oy] = place(Math.cos(a) * rad, Math.sin(a) * rad);
        pushStar(gx + ox, gy + oy, allFiles[i], now, 0.9, g.label, 0.42, g.root);
      }

      // 根目录下的散落文件
      if (g.looseFiles && g.looseFiles.length) {
        const sample = pickFiles(g.looseFiles, 300);
        const rr2 = mulberry(strSeed(g.root) + 7);
        for (const f of sample) {
          const a = rr2() * TAU;
          const rad = 50 + rr2() * gR * 0.2;
          const [ox, oy] = place(Math.cos(a) * rad, Math.sin(a) * rad);
          pushStar(gx + ox, gy + oy, f, now, 1.1, g.label, 1, g.root);
        }
      }

      // 目录分配到各条臂
      const slots = Array.from({ length: armCount }, () => []);
      nebs.forEach((nb, ni) => slots[ni % armCount].push(nb));

      const layout = new Map();
      slots.forEach((list, a) => {
        const A = arms[a];
        const start = 0.06;
        const stop = A.uMax;
        const weights = list.map((nb) => Math.sqrt(Math.max(10, nb.count)));
        const total = weights.reduce((x, y) => x + y, 0) || 1;
        let acc = 0;
        list.forEach((nb, k) => {
          const frac = weights[k] / total;
          layout.set(nb, {
            arm: a,
            u0: start + acc * (stop - start),
            u1: start + (acc + frac) * (stop - start)
          });
          acc += frac;
        });
      });

      const maxNebSize = Math.max(1, ...nebs.map((x) => x.size));

      nebs.forEach((neb) => {
        const L = layout.get(neb);
        const nR = 42 + 92 * normLog(neb.size, maxNebSize);
        const nr = mulberry(strSeed(g.root + '/' + neb.name));
        const gauss = () => {
          let g2 = 0;
          for (let j = 0; j < 4; j++) g2 += nr();
          return (g2 - 2) * 0.65;
        };

        const sample = pickFiles(neb.files, MAX_PER_NEBULA);
        let tintSum = 0;
        for (const f of sample) tintSum += ageT(f.t, now);
        const tint = sample.length ? tintSum / sample.length : 0.5;

        const A = arms[L.arm];
        const span = Math.max(0.006, L.u1 - L.u0);
        const um = (L.u0 + L.u1) / 2;
        const thM = A.phase + um * A.turn + wobble(um) * 5.5;
        const rM = radiusAt(um);
        const [mox, moy] = place(Math.cos(thM) * rM, Math.sin(thM) * rM);
        const nx = gx + mox;
        const ny = gy + moy;
        const nebR = Math.max(nR * 1.6, rM * span * A.turn * 0.5);

        const k2 = sample.length;
        const starStart = U.stars.length;
        const aScale = clamp(1500 / Math.max(60, k2), 0.24, 1.15);

        // ---- 引力分层 ----
        // 二级子目录 = 恒星（引力中心），文件绕着各自的恒星分布。
        // 这样「目录层级」和「天体层级」对上了：星系 → 星云 → 恒星 → 行星/尘埃。
        const subs = new Map();
        for (const f of sample) {
          const seg = f.p.split('/');
          const key = seg.length > 2 ? seg[1] : '';
          let arr = subs.get(key);
          if (!arr) { arr = []; subs.set(key, arr); }
          arr.push(f);
        }

        let groups = [...subs.entries()].sort((a, b) => b[1].length - a[1].length);
        const MAX_GROUPS = 14;
        if (groups.length > MAX_GROUPS) {
          const rest = [];
          for (let g = MAX_GROUPS - 1; g < groups.length; g++) rest.push(...groups[g][1]);
          groups = groups.slice(0, MAX_GROUPS - 1);
          groups.push(['…', rest]);
        }

        const totalN = groups.reduce((a, g) => a + g[1].length, 0) || 1;
        let accU = 0;
        const systems = [];
        for (const [name, arr] of groups) {
          const frac = arr.length / totalN;
          const su0 = L.u0 + span * accU;
          const su1 = L.u0 + span * (accU + frac);
          accU += frac;
          const um2 = (su0 + su1) / 2;
          const th2 = A.phase + um2 * A.turn + wobble(um2) * 5.5;
          const rm2 = radiusAt(um2);
          const [sgx, sgy] = place(Math.cos(th2) * rm2, Math.sin(th2) * rm2);
          systems.push({
            name, arr, su0, su1,
            x: gx + sgx, y: gy + sgy,
            r: Math.max(8, nR * 0.85)
          });
        }

        // 文件仍然沿臂铺开，只是各自归到某个「恒星」的弧段里 ——
        // 否则整个星云会碎成一颗颗白球，把旋臂的结构打散。
        for (const sys of systems) {
          const su = Math.max(0.004, sys.su1 - sys.su0);
          for (const f of sys.arr) {
            const u = clamp(sys.su0 + su * nr(), -0.03, 1.03);
            const th = A.phase + u * A.turn + wobble(u) * 5.5;
            const rr = radiusAt(u);
            const dr = gauss() * nR * (0.35 + 0.55 * clamp(u, 0, 1));
            const [px, py] = place(Math.cos(th) * (rr + dr), Math.sin(th) * (rr + dr));
            pushStar(gx + px, gy + py, f, now, 1, g.label, aScale, g.root);
          }
          if (sys.arr.length >= 12) {
            U.starSystems.push({
              x: sys.x, y: sys.y, r: sys.r,
              name: sys.name, nebula: neb.name, count: sys.arr.length
            });
          }
        }

        for (let j = starStart; j < U.stars.length; j++) U.stars[j].nebR = nR;

        U.nebulas.push({
          x: nx, y: ny, r: nebR,
          name: neb.name, galaxy: g.label, root: g.root,
          size: neb.size, count: neb.count, tint
        });
      });

      // 盘面弥散星尘
      const diskRand = mulberry(strSeed(g.root) + 77);
      const reach = Math.max(...arms.map((A) => A.uMax));
      for (let i = 0; i < 2200 && allFiles.length; i++) {
        const a = diskRand() * TAU;
        const rr3 = gR * (0.1 + 0.92 * Math.sqrt(diskRand())) * reach;
        const [px, py] = place(Math.cos(a) * rr3, Math.sin(a) * rr3);
        pushStar(
          gx + px, gy + py,
          allFiles[Math.floor(diskRand() * allFiles.length)],
          now, 0.55, g.label, 0.2, g.root
        );
      }
    });

    // 按色温分桶排序，渲染时一次设置 fillStyle 画一大片
    const buckets = Array.from({ length: BUCKETS }, () => []);
    for (const s of U.stars) buckets[s.bucket].push(s);
    U.stars = [].concat(...buckets);

    // 超大文件 = 黑洞：它们吸走了硬盘里最可观的一部分质量
    U.holes = [];
    for (const st of U.stars) {
      if (st.f.s > 320 * 1024 * 1024) U.holes.push(st);
    }

    // 去重后的文件索引：搜索和结果列表都基于它
    const seen = new Set();
    U.index = [];
    for (const st of U.stars) {
      const f = st.f;
      if (seen.has(f)) continue;
      seen.add(f);
      U.index.push({ f, star: st });
    }

    U.matches = 0;
    if (U.query) applySearch();
    window.__cosmos = U; // 调试用
    markDirty();
  }

  function pushStar(x, y, f, now, scale, galaxyLabel, aScale, galaxyRoot) {
    const t = ageT(f.t, now);
    const worldR = (0.55 + 1.9 * Math.log10(1 + f.s / 512)) * scale;
    U.stars.push({
      x, y, r: Math.min(worldR, 7),
      t, bucket: ageBucket(t),
      bright: f.s > 120 * 1024 * 1024,
      galaxyLabel, root: galaxyRoot, a: aScale || 1,
      f
    });
  }

  /** 星体记录里存的是相对星系根的路径，这里还原成绝对路径 */
  function absOf(star) {
    return `${star.root}/${star.f.p}`;
  }

  /* ---------------------------------------------------------- 相机 */

  function screenToWorld(sx, sy) {
    return {
      x: (sx - U.w / 2) / U.cam.z + U.cam.x,
      y: (sy - U.h / 2) / U.cam.z + U.cam.y
    };
  }

  function bboxOfAll() {
    if (!U.cores.length) return { x: 0, y: 0, w: 1, h: 1 };
    // 抽样取分位，避免少数离群星把整个视野撑成一片黑
    const step = Math.max(1, Math.floor(U.stars.length / 4000));
    const xs = [];
    const ys = [];
    for (let i = 0; i < U.stars.length; i += step) {
      xs.push(U.stars[i].x);
      ys.push(U.stars[i].y);
    }
    if (!xs.length) return { x: 0, y: 0, w: 1, h: 1 };
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    const pick = (arr, q) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * q)))];
    const x0 = pick(xs, 0.005);
    const x1 = pick(xs, 0.995);
    const y0 = pick(ys, 0.005);
    const y1 = pick(ys, 0.995);
    const pad = 0.08;
    // 尺寸按星点算，但视野中心对准星系核，否则臂偏一边时构图会歪
    let cx = 0;
    let cy = 0;
    for (const c of U.cores) { cx += c.x; cy += c.y; }
    cx /= U.cores.length;
    cy /= U.cores.length;
    return {
      x: cx, y: cy,
      w: Math.max(1, x1 - x0) * (1 + pad),
      h: Math.max(1, y1 - y0) * (1 + pad)
    };
  }

  function fitAll() {
    const bb = bboxOfAll();
    const z = clamp(Math.min(U.w / (bb.w * 1.15), U.h / (bb.h * 1.15)), 0.02, 4);
    U.target = { x: bb.x, y: bb.y, z };
    markDirty();
  }

  function focusOn(cx, cy, radius) {
    const z = clamp(Math.min(U.w / (radius * 2.4), U.h / (radius * 2.4)), 0.03, 6);
    U.target = { x: cx, y: cy, z };
    markDirty();
  }

  function stepCamera() {
    if (!U.target) return false;
    const t = U.target;
    const k = 0.16;
    const dx = t.x - U.cam.x, dy = t.y - U.cam.y;
    const dz = t.z - U.cam.z;
    U.cam.x += dx * k; U.cam.y += dy * k; U.cam.z += dz * k;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dz) < 0.002) {
      U.cam = { ...t }; U.target = null;
    }
    return true;
  }

  /* ---------------------------------------------------------- 渲染 */

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    U.dpr = dpr;
    U.w = window.innerWidth;
    U.h = window.innerHeight;
    canvas.width = Math.round(U.w * dpr);
    canvas.height = Math.round(U.h * dpr);
    canvas.style.width = U.w + 'px';
    canvas.style.height = U.h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    markDirty();
  }

  const SPACE_DUST = Array.from({ length: 260 }, (_, i) => {
    const r = mulberry(9001 + i);
    return { x: r(), y: r(), s: 0.3 + r() * 0.9, a: 0.05 + r() * 0.18, d: 0.02 + r() * 0.06 };
  });

  function draw(t) {
    const { w, h, cam } = U;
    const z = cam.z;
    const ox = w / 2 - cam.x * z;
    const oy = h / 2 - cam.y * z;
    const toSX = (x) => x * z + ox;
    const toSY = (y) => y * z + oy;

    // 深空底色
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#07080b';
    ctx.fillRect(0, 0, w, h);

    // 背景星尘（视差）
    for (const d of SPACE_DUST) {
      const px = ((d.x * w - cam.x * z * d.d) % w + w) % w;
      const py = ((d.y * h - cam.y * z * d.d) % h + h) % h;
      ctx.globalAlpha = d.a;
      ctx.fillStyle = '#aab4c4';
      ctx.fillRect(px, py, d.s, d.s);
    }
    ctx.globalAlpha = 1;

    // 辉光层
    ctx.globalCompositeOperation = 'lighter';

    // 远景：星云退化成柔光斑，否则几颗像素点撑不起星系的轮廓
    for (const nb of U.nebulas) {
      const rs = nb.r * z;
      if (rs >= 26) continue;
      const sx = toSX(nb.x), sy = toSY(nb.y);
      if (sx < -60 || sx > w + 60 || sy < -60 || sy > h + 60) continue;
      const rr = Math.max(7, rs * 2.4);
      const bi = Math.min(BUCKETS - 1, Math.round(nb.tint * (BUCKETS - 1)));
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rr);
      g.addColorStop(0, hexA(BUCKET_COLORS[bi], 0.3));
      g.addColorStop(0.45, hexA(BUCKET_COLORS[bi], 0.085));
      g.addColorStop(1, hexA(BUCKET_COLORS[bi], 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, Math.PI * 2);
      ctx.fill();
    }

    // 星云光晕
    for (const nb of U.nebulas) {
      const r = nb.r * z * 1.55;
      if (r < 3) continue;
      const sx = toSX(nb.x), sy = toSY(nb.y);
      if (sx + r < 0 || sx - r > w || sy + r < 0 || sy - r > h) continue;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      const tint = BUCKET_COLORS[Math.min(BUCKETS - 1, Math.round(nb.tint * (BUCKETS - 1)) || 0)];
      g.addColorStop(0, hexA(tint, 0.075));
      g.addColorStop(0.5, hexA(tint, 0.026));
      g.addColorStop(1, hexA(tint, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();

      // 星云核：小而暗的星云也能被看见、被点中
      const cr = Math.max(1, Math.min(3.2, nb.r * z * 0.045));
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = BUCKET_COLORS[Math.min(BUCKETS - 1, Math.round(nb.tint * (BUCKETS - 1)))];
      ctx.beginPath();
      ctx.arc(sx, sy, cr, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 恒星系统（二级目录）：放大后是旋臂上的亮结
    if (z > 1.05 && U.starSystems.length) {
      for (const sys of U.starSystems) {
        const sx = toSX(sys.x), sy = toSY(sys.y);
        if (sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) continue;
        const cr = Math.max(1.4, Math.min(3.4, Math.sqrt(sys.count) * 0.22 * z));
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, cr * 9);
        g.addColorStop(0, 'rgba(255, 244, 224, 0.5)');
        g.addColorStop(0.25, 'rgba(255, 214, 160, 0.13)');
        g.addColorStop(1, 'rgba(255, 214, 160, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sx, sy, cr * 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 250, 240, 0.95)';
        ctx.beginPath();
        ctx.arc(sx, sy, cr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 星点
    const threshold = 0.34;
    // 放大之后每颗星都变大，叠加会迅速过曝 —— 按缩放收一点曝光
    const exposure = clamp(Math.pow(0.62 / z, 0.4), 0.28, 1.0) * U.gain;
    let cur = -1;
    for (let i = 0; i < U.stars.length; i++) {
      const s = U.stars[i];
      if (s.nebR && s.nebR * z < 26 && s.r < 3.4) continue;
      // 屏幕尺寸的增长要比 zoom 慢得多，否则一放大每颗星就摊成一个大圆盘
      const sr = Math.min(s.r * Math.pow(z, 0.55), 18);
      if (sr < threshold) continue;
      const sx = s.x * z + ox;
      const sy = s.y * z + oy;
      if (sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) continue;

      const dim = s.dim ? 0.12 : 1;
      const col = BUCKET_COLORS[s.bucket];
      const alpha = (s.a || 1) * dim * exposure;

      if (sr < 1.4) {
        if (s.bucket !== cur) { cur = s.bucket; ctx.fillStyle = col; }
        const wpx = Math.max(1, sr);
        ctx.globalAlpha = 0.1 * alpha;
        ctx.fillRect(sx - wpx * 0.5, sy - wpx * 0.5, wpx, wpx);
        continue;
      }

      // 恒星：小而亮的核心 + 一层一层散开的光晕，而不是一个实心圆
      const core = Math.min(sr * 0.5, 2.8);
      const halo = sr * 3.4;

      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, halo);
      g.addColorStop(0, hexA(col, 0.3 * alpha));
      g.addColorStop(0.14, hexA(col, 0.11 * alpha));
      g.addColorStop(0.4, hexA(col, 0.03 * alpha));
      g.addColorStop(1, hexA(col, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, halo, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.9 * alpha;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(sx, sy, core, 0, Math.PI * 2);
      ctx.fill();

      // 星芒只留给真正的大质量恒星，满屏十字就成噪声了
      if (s.bright && sr > 4.5) {
        const len = sr * 1.5;
        ctx.globalAlpha = 0.13 * alpha;
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(0.5, sr * 0.07);
        ctx.beginPath();
        ctx.moveTo(sx - len, sy); ctx.lineTo(sx + len, sy);
        ctx.moveTo(sx, sy - len); ctx.lineTo(sx, sy + len);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // 黑洞：超大文件用一张吸积盘盖住背景，一眼就能认出它吃了多少空间
    if (U.holes && U.holes.length) {
      ctx.globalCompositeOperation = 'source-over';
      for (const h of U.holes) {
        const sr = Math.min(h.r * Math.pow(z, 0.55), 18);
        if (sr < 2) continue;
        const sx = h.x * z + ox;
        const sy = h.y * z + oy;
        if (sx < -120 || sx > w + 120 || sy < -120 || sy > h + 120) continue;
        const R = sr * 2.1;

        const g = ctx.createRadialGradient(sx, sy, R * 0.7, sx, sy, R * 2.6);
        g.addColorStop(0, 'rgba(255, 140, 70, 0)');
        g.addColorStop(0.3, 'rgba(255, 150, 80, 0.16)');
        g.addColorStop(0.62, 'rgba(200, 90, 60, 0.05)');
        g.addColorStop(1, 'rgba(200, 90, 60, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sx, sy, R * 2.6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#04050a';
        ctx.beginPath();
        ctx.arc(sx, sy, R * 0.78, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 176, 110, 0.6)';
        ctx.lineWidth = Math.max(1, sr * 0.22);
        ctx.beginPath();
        ctx.arc(sx, sy, R * 0.95, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 220, 180, 0.18)';
        ctx.lineWidth = Math.max(0.6, sr * 0.1);
        ctx.beginPath();
        ctx.arc(sx, sy, R * 1.25, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'lighter';
    }

    // 搜索只圈当前选中的那一个，圈多了画面就毁了
    if (U.query && U.searchHits && U.searchHits.length) {
      const act = U.searchHits[U.activeHit];
      if (act && act.star) {
        const ss = act.star;
        const sx = ss.x * z + ox, sy = ss.y * z + oy;
        const rr = Math.max(6, ss.r * z * 2.6);
        ctx.strokeStyle = 'rgba(255, 214, 150, 0.95)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(sx, sy, rr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255, 214, 150, 0.25)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, rr * 2.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 星系核心
    for (const c of U.cores) {
      const sx = toSX(c.x), sy = toSY(c.y);
      const rr = clamp(c.r * z * 0.011, 2, 5);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rr * 11);
      g.addColorStop(0, 'rgba(255, 238, 208, 0.5)');
      g.addColorStop(0.2, 'rgba(224, 176, 114, 0.14)');
      g.addColorStop(1, 'rgba(224, 176, 114, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, rr * 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 246, 232, 0.95)';
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';

    // ---- 标签与交互高亮 ----
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (const c of U.cores) {
      const sx = toSX(c.x), sy = toSY(c.y);
      const rr = clamp(c.r * z * 0.011, 2, 5);
      ctx.font = '500 13px -apple-system, "SF Pro Text", "PingFang SC", sans-serif';
      const sub = fmtSize(c.size) + '  ·  ' + c.count.toLocaleString() + ' 颗';
      const tw = Math.max(ctx.measureText(c.name).width, 60);
      const bx = sx - tw / 2 - 8, by = sy + rr + 7;
      ctx.fillStyle = 'rgba(7, 8, 11, 0.5)';
      ctx.beginPath();
      ctx.roundRect(bx, by, tw + 16, 42, 7);
      ctx.fill();
      ctx.fillStyle = 'rgba(232, 234, 238, 0.94)';
      ctx.fillText(c.name, sx, by + 7);
      ctx.font = '11px -apple-system, "SF Pro Text", "PingFang SC", sans-serif';
      ctx.fillStyle = 'rgba(150, 156, 166, 0.8)';
      ctx.fillText(sub, sx, by + 25);
    }

    if (z > 0.42) {
      const taken = [];
      ctx.font = '11px -apple-system, "SF Pro Text", "PingFang SC", sans-serif';
      for (const nb of U.nebulas) {
        const sx = toSX(nb.x), sy = toSY(nb.y);
        if (nb.count < 50) continue;
        const rr = nb.r * z;
        if (rr < 16) continue;
        if (sx < -100 || sx > w + 100 || sy < -100 || sy > h + 100) continue;
        const tw = ctx.measureText(nb.name).width;
        const lx = sx - tw / 2;
        const ly = sy + rr * 0.92 + 2;
        // 挤在一起就不画，别把标签叠成一坨
        if (taken.some((r) => Math.abs(r.x - lx) < (r.w + tw) / 2 + 6 && Math.abs(r.y - ly) < 14)) continue;
        taken.push({ x: lx, y: ly, w: tw });
        ctx.fillStyle = 'rgba(197, 203, 212, ' + clamp((rr - 16) / 40, 0, 0.62).toFixed(2) + ')';
        ctx.fillText(nb.name, sx, ly + 11);
      }
    }

    // 放得足够大时，把「恒星」（二级目录）当作星图标注写出来
    if (z > 2.4) {
      const taken2 = [];
      ctx.font = '10px -apple-system, "SF Pro Text", "PingFang SC", sans-serif';
      for (const sys of U.starSystems) {
        if (sys.count < 24) continue;
        const sx = toSX(sys.x), sy = toSY(sys.y);
        if (sx < 40 || sx > w - 40 || sy < 40 || sy > h - 20) continue;
        const label = sys.name || '(根目录)';
        const tw = ctx.measureText(label).width;
        const lx = sx - tw / 2;
        const ly = sy + 7;
        if (taken2.some((r) => Math.abs(r.x - lx) < (r.w + tw) / 2 + 10 && Math.abs(r.y - ly) < 12)) continue;
        taken2.push({ x: lx, y: ly, w: tw });
        ctx.fillStyle = 'rgba(150, 160, 176, 0.6)';
        ctx.fillText(label, sx, ly + 9);
      }
    }

    // hover / selected
    const mark = (s, strong) => {
      if (!s) return;
      const sx = s.x * z + ox, sy = s.y * z + oy;
      const rr = Math.max(5, s.r * z * 1.9);
      ctx.strokeStyle = strong ? 'rgba(224, 176, 114, 0.95)' : 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = strong ? 1.4 : 1;
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, Math.PI * 2);
      ctx.stroke();
      if (strong) {
        ctx.strokeStyle = 'rgba(224, 176, 114, 0.22)';
        ctx.beginPath();
        ctx.arc(sx, sy, rr * 2.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    };
    mark(U.hover, false);
    mark(U.selected && U.selected.f ? U.selected : null, true);
  }

  function hexA(rgb, a) {
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(rgb);
    if (!m) return rgb;
    return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  }

  /* ---------------------------------------------------------- 交互 */

  let drag = null;
  let pointer = { x: 0, y: 0 };

  function hitTest(mx, my) {
    const z = U.cam.z;
    const ox = U.w / 2 - U.cam.x * z;
    const oy = U.h / 2 - U.cam.y * z;
    let best = null;
    let bestD = 14 * 14;

    // 先找星点
    for (let i = 0; i < U.stars.length; i++) {
      const s = U.stars[i];
      if (s.dim) continue;
      const sx = s.x * z + ox, sy = s.y * z + oy;
      const dx = sx - mx, dy = sy - my;
      const d = dx * dx + dy * dy;
      const rr = Math.max(s.r * z, 6);
      if (d < Math.min(bestD, rr * rr * 2.2)) { bestD = d; best = s; }
    }
    if (best) return { f: best.f, star: best, kind: 'file' };

    // 先找恒星系统（二级目录），放大后才可见
    if (z > 1.6) {
      for (const sys of U.starSystems || []) {
        const sx = sys.x * z + ox, sy = sys.y * z + oy;
        const rr = Math.max(sys.r * z, 10);
        if ((sx - mx) ** 2 + (sy - my) ** 2 < rr * rr * 1.6) {
          return { kind: 'system', system: sys };
        }
      }
    }

    // 再找星云
    for (const nb of U.nebulas) {
      const sx = nb.x * z + ox, sy = nb.y * z + oy;
      const d = (sx - mx) ** 2 + (sy - my) ** 2;
      const rr = Math.max(nb.r * z, 26);
      if (d < rr * rr) { best = nb; bestD = d; }
    }
    if (best) return { kind: 'nebula', nebula: best };

    // 最后找星系
    for (const c of U.cores) {
      const sx = c.x * z + ox, sy = c.y * z + oy;
      if ((sx - mx) ** 2 + (sy - my) ** 2 < 26 * 26) return { kind: 'galaxy', core: c };
    }
    return null;
  }

  function setHover(h) {
    const prev = U.hoverObj;
    const changed = !(
      (prev === null && h === null) ||
      (prev && h && prev.kind === h.kind &&
        ((h.kind === 'file' && prev.star === h.star) ||
         (h.kind === 'nebula' && prev.nebula === h.nebula) ||
         (h.kind === 'galaxy' && prev.core === h.core)))
    );
    U.hoverObj = h;
    U.hover = h && h.star ? h.star : null;
    canvas.classList.toggle('pointing', !!h);

    const tip = $('tooltip');
    if (h && (h.kind === 'file' || h.kind === 'nebula' || h.kind === 'system')) {
      tip.hidden = false;
      tip.textContent = '';
      const name = document.createElement('span');
      const dim = document.createElement('span');
      dim.className = 'dim';
      if (h.kind === 'file') {
        name.textContent = h.f.n;
        dim.textContent = fmtSize(h.f.s);
      } else if (h.kind === 'system') {
        name.textContent = '★ ' + h.system.name;
        dim.textContent = h.system.count.toLocaleString() + ' 颗 · ' + h.system.nebula;
      } else {
        name.textContent = '◈ ' + h.nebula.name;
        dim.textContent = h.nebula.count.toLocaleString() + ' 颗 · ' + fmtSize(h.nebula.size);
      }
      tip.append(name, dim);
      tip.style.left = Math.min(pointer.x + 14, U.w - 280) + 'px';
      tip.style.top = pointer.y + 16 + 'px';
    } else {
      tip.hidden = true;
    }
    if (changed) markDirty();
  }

  /* ---------------------------------------------------------- 搜索 */

  const SIZE_UNITS = { b: 1, k: 1024, kb: 1024, m: 1048576, mb: 1048576, g: 1073741824, gb: 1073741824 };

  function parseSize(txt) {
    const m = /^([\d.]+)\s*(b|kb|k|mb|m|gb|g)?$/i.exec(txt);
    if (!m) return 0;
    return parseFloat(m[1]) * (SIZE_UNITS[(m[2] || 'b').toLowerCase()] || 1);
  }

  /** 把 "*.js >10mb path:books 报告" 这样的查询拆成条件 */
  function parseQuery(raw) {
    const q = { terms: [], exts: [], paths: [], minSize: 0, maxSize: Infinity };
    for (const t of raw.trim().split(/\s+/)) {
      if (!t) continue;
      const low = t.toLowerCase();
      if (low.startsWith('ext:')) q.exts.push(low.slice(4).replace(/^\./, ''));
      else if (low.startsWith('path:')) q.paths.push(low.slice(5));
      else if (low.startsWith('>')) q.minSize = parseSize(low.slice(1));
      else if (low.startsWith('<')) q.maxSize = parseSize(low.slice(1));
      else if (low.startsWith('*.')) q.exts.push(low.slice(2));
      else if (low.startsWith('.') && !low.slice(1).includes('.')) q.exts.push(low.slice(1));
      else q.terms.push(low);
    }
    return q;
  }

  /** 子串命中优先，否则退化为按顺序的模糊匹配；分数越高越靠前 */
  function scoreName(q, name) {
    const n = name.toLowerCase();
    const idx = n.indexOf(q);
    if (idx === 0) return 1000 - n.length;
    if (idx > 0) {
      // 路径分隔符或单词边界上的命中更值钱
      const boundary = n[idx - 1] === '.' || n[idx - 1] === '_' || n[idx - 1] === '-' || n[idx - 1] === ' ';
      return (boundary ? 720 : 600) - idx * 2 - n.length * 0.05;
    }
    let qi = 0, score = 0, last = -2;
    for (let i = 0; i < n.length && qi < q.length; i++) {
      if (n[i] !== q[qi]) continue;
      score += i === last + 1 ? 6 : 2;
      if (i === 0 || n[i - 1] === '.' || n[i - 1] === '_' || n[i - 1] === '-' || n[i - 1] === '/') score += 5;
      last = i;
      qi++;
    }
    return qi === q.length ? score - n.length * 0.02 : -1;
  }

  function runSearch(raw) {
    const q = parseQuery(raw);
    const hasTerm = q.terms.length > 0;
    const hasFilter = q.exts.length > 0 || q.paths.length > 0 || q.minSize > 0 || q.maxSize < Infinity;
    if (!hasTerm && !hasFilter) return [];

    const out = [];
    for (const ent of U.index) {
      const f = ent.f;
      const ext = (f.e || '').toLowerCase();
      if (q.exts.length && !q.exts.includes(ext)) continue;
      if (f.s < q.minSize || f.s > q.maxSize) continue;

      const name = f.n.toLowerCase();
      const p = f.p.toLowerCase();

      if (q.paths.length) {
        let ok = true;
        for (const pp of q.paths) if (!p.includes(pp)) { ok = false; break; }
        if (!ok) continue;
      }

      let score = 0;
      if (hasTerm) {
        for (const term of q.terms) {
          const s1 = scoreName(term, name);
          const s2 = scoreName(term, p);
          const best = Math.max(s1, s2 >= 0 ? s2 * 0.55 : -1);
          if (best < 0) { score = -1; break; }
          score += best;
        }
        if (score < 0) continue;
      } else {
        // 纯条件查询：大的靠前
        score = Math.log10(1 + f.s);
      }
      out.push({ f, star: ent.star, score });
    }

    out.sort((a, b) => b.score - a.score);
    return out;
  }

  function highlightName(name, raw) {
    const q = parseQuery(raw);
    const term = q.terms[0];
    if (!term) return document.createTextNode(name);
    const lower = name.toLowerCase();
    const idx = lower.indexOf(term);
    if (idx < 0) return document.createTextNode(name);
    const frag = document.createDocumentFragment();
    frag.append(name.slice(0, idx));
    const b = document.createElement('b');
    b.textContent = name.slice(idx, idx + term.length);
    frag.append(b, name.slice(idx + term.length));
    return frag;
  }

  function renderResults() {
    const box = $('results');
    const list = $('resultsList');
    const items = U.searchHits;
    if (!U.query.trim()) { box.hidden = true; return; }

    box.hidden = false;
    list.innerHTML = '';

    $('resultsHead').textContent = items.length
      ? `${items.length.toLocaleString()} 个结果${items.length > 60 ? ' · 显示前 60 个' : ''}`
      : '没有匹配的星体';

    const slice = items.slice(0, 60);
    if (U.activeHit >= slice.length) U.activeHit = 0;

    slice.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'res-item' + (i === U.activeHit ? ' on' : '');
      const dot = document.createElement('i');
      dot.className = 'res-icon';
      dot.style.background = BUCKET_COLORS[ageBucket(ageT(it.f.t, Date.now()))];
      const main = document.createElement('div');
      main.className = 'res-main';
      const name = document.createElement('div');
      name.className = 'res-name';
      name.append(highlightName(it.f.n, U.query));
      const sub = document.createElement('div');
      sub.className = 'res-sub';
      sub.textContent = it.f.p;
      main.append(name, sub);
      const size = document.createElement('div');
      size.className = 'res-size';
      size.textContent = fmtSize(it.f.s);
      row.append(dot, main, size);
      row.onmouseenter = () => { if (U.activeHit !== i) { U.activeHit = i; refreshActive(); } };
      row.onclick = (e) => { U.activeHit = i; if (e.shiftKey) openViewer(it.f, it.star); else locateStar(it.star, it.f); };
      list.append(row);
    });

    if (U.activeHit >= 0 && slice[U.activeHit]) {
      const on = list.children[U.activeHit];
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }
  }

  function refreshActive() {
    const list = $('resultsList');
    [...list.children].forEach((el, i) => el.classList.toggle('on', i === U.activeHit));
    markDirty();
  }

  function applySearch() {
    const q = U.query.trim().toLowerCase();
    if (!q) {
      for (const s of U.stars) s.dim = false;
      U.matches = 0;
      U.searchHits = [];
      U.activeHit = 0;
      $('results').hidden = true;
      markDirty();
      return;
    }

    U.searchHits = runSearch(U.query);
    U.activeHit = 0;
    U.matches = U.searchHits.length;

    const hitSet = new Set(U.searchHits.map((h) => h.f));
    for (const s of U.stars) s.dim = !hitSet.has(s.f);

    renderResults();
    markDirty();
  }

  /** 把镜头对准某颗星并选中它 */
  function locateStar(star, f) {
    U.selected = star;
    const z = Math.max(U.cam.z, 1.1);
    U.target = { x: star.x, y: star.y, z };
    $('results').hidden = true;
    markDirty();
  }

  /* ---------------------------------------------------------- 面板 */

  /* ---------------------------------------------------------- 大查看器 */

  /** 原生壳（Swift）注入的桥接；在普通浏览器里返回 false */
  function nativeBridge(action, path) {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge;
    if (!h) return false;
    h.postMessage({ action, path });
    return true;
  }

  function viewerMeta(f, abs) {
    const foot = $('viewerFoot');
    foot.textContent = '';
    const parts = [
      fmtSize(f.s),
      fmtDate(f.t),
      Math.floor((Date.now() - f.t) / DAY) + ' 天前',
      abs
    ];
    for (const t of parts) {
      const el = document.createElement('span');
      el.textContent = t;
      foot.append(el);
    }
  }

  const KW = {
    js: 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|from|default|delete|void|static|get|set|null|undefined|true|false',
    py: 'def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|lambda|pass|yield|global|nonlocal|assert|del|async|await|self',
    go: 'func|package|import|return|if|else|for|range|switch|case|default|struct|interface|type|var|const|map|chan|go|defer|select|break|continue|nil|true|false',
    rs: 'fn|let|mut|pub|use|struct|enum|impl|match|if|else|for|while|loop|return|self|Self|const|static|trait|where|mod|crate|as|in|move|ref|dyn|async|await|unsafe',
    c: 'int|char|void|float|double|struct|union|enum|typedef|return|if|else|for|while|switch|case|break|continue|sizeof|static|const|extern|unsigned|long|short|signed|class|public|private|protected|namespace|using|template|virtual|new|delete|try|catch|throw'
  };
  const LANG_OF = {
    js: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', jsx: 'js', json: 'js', vue: 'js', svelte: 'js',
    py: 'py', rb: 'py', sh: 'py', bash: 'py', zsh: 'py', yml: 'py', yaml: 'py', toml: 'py',
    go: 'go', rs: 'rs',
    c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', m: 'c', mm: 'c', java: 'c', kt: 'c', swift: 'c', cs: 'c',
    css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', xml: 'html', svg: 'html'
  };

  function highlightLine(text, lang) {
    const frag = document.createDocumentFragment();
    if (!lang) { frag.append(text || ' '); return frag; }
    const kw = KW[lang];
    const hashComment = lang === 'py' || lang === 'css';
    const re = new RegExp(
      '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' + (hashComment ? '|#[^\\n]*' : '') + ')' +
      '|("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)' +
      '|(\\b\\d+(?:\\.\\d+)?\\b)' +
      (kw ? '|(\\b(?:' + kw + ')\\b)' : ''),
      'g'
    );
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const span = document.createElement('span');
      span.textContent = m[0];
      span.className = m[1] ? 'tok-c' : m[2] ? 'tok-s' : m[3] ? 'tok-n' : 'tok-k';
      frag.append(span);
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < text.length) frag.append(text.slice(last));
    if (!text) frag.append(' ');
    return frag;
  }

  function renderCode(body, text, truncated, ext) {
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    const table = document.createElement('table');
    table.className = 'code-table';
    const tbody = document.createElement('tbody');
    const frag = document.createDocumentFragment();
    const lines = text.split('\n');
    const lang = lines.length <= 900 ? LANG_OF[(ext || '').toLowerCase()] || null : null;
    for (let i = 0; i < lines.length; i++) {
      const tr = document.createElement('tr');
      const no = document.createElement('td');
      no.className = 'code-no';
      no.textContent = i + 1;
      const ln = document.createElement('td');
      ln.className = 'code-line';
      ln.append(highlightLine(lines[i], lang));
      tr.append(no, ln);
      frag.append(tr);
    }
    tbody.append(frag);
    table.append(tbody);
    wrap.append(table);
    body.append(wrap);
    if (truncated) {
      const note = document.createElement('div');
      note.className = 'viewer-empty';
      note.style.padding = '14px';
      note.textContent = '（只显示开头部分，完整内容请外部打开）';
      wrap.append(note);
    }
  }

  async function openViewer(f, star) {
    if (!f || !star) return;
    const abs = `${star.root}/${f.p}`;
    const body = $('viewerBody');
    $('viewerName').textContent = f.n;
    $('viewerPath').textContent = abs;
    body.innerHTML = '';
    body.className = 'viewer-body';
    const load = document.createElement('div');
    load.className = 'viewer-empty';
    load.textContent = '正在读取…';
    body.append(load);
    $('viewer').hidden = false;
    viewerMeta(f, abs);
    U.viewerAbs = abs;

    let data;
    try {
      data = await api(`/api/preview?path=${encodeURIComponent(abs)}&lines=1200`);
    } catch (e) {
      body.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'viewer-empty';
      err.textContent = e.message;
      body.append(err);
      return;
    }

    body.innerHTML = '';
    if (data.kind === 'image') {
      const img = document.createElement('img');
      img.src = data.url;
      img.alt = f.n;
      body.append(img);
    } else if (data.kind === 'pdf') {
      const ifr = document.createElement('iframe');
      ifr.src = data.url;
      body.append(ifr);
    } else if (data.kind === 'video') {
      const v = document.createElement('video');
      v.src = data.url;
      v.controls = true;
      v.autoplay = true;
      body.append(v);
    } else if (data.kind === 'audio') {
      const a = document.createElement('audio');
      a.src = data.url;
      a.controls = true;
      a.autoplay = true;
      body.append(a);
    } else if (data.kind === 'text') {
      renderCode(body, data.content, data.truncated, data.ext);
    } else {
      const empty = document.createElement('div');
      empty.className = 'viewer-empty';
      empty.innerHTML = '';
      const strong = document.createElement('strong');
      strong.textContent = f.n;
      empty.append(strong, document.createElement('br'), document.createTextNode('这个文件没法内嵌预览'));
      const hint = document.createElement('div');
      hint.style.marginTop = '14px';
      hint.textContent = '试试「快速预览」——它能打开 macOS 认识的几乎所有格式。';
      empty.append(hint);
      body.append(empty);
    }
  }

  function closeViewer() {
    $('viewer').hidden = true;
    $('viewerBody').innerHTML = '';
  }

  function showNebulaPanel(nb) {
    const panel = $('panel');
    const body = $('panelBody');
    panel.hidden = false;
    body.innerHTML = '';

    const kind = document.createElement('div');
    kind.className = 'kind';
    kind.textContent = '星云';
    const title = document.createElement('h1');
    title.className = 'title';
    title.textContent = nb.name;
    const p = document.createElement('div');
    p.className = 'path';
    p.textContent = nb.root + '/' + nb.name;

    const meta = document.createElement('dl');
    meta.className = 'meta';
    meta.innerHTML = `
      <div><dt>质量</dt><dd>${fmtSize(nb.size)}</dd></div>
      <div><dt>恒星数</dt><dd>${nb.count.toLocaleString()}</dd></div>
      <div><dt>所属星系</dt><dd>${(nb.galaxy || '').replace(/</g, '&lt;')}</dd></div>
      <div><dt>平均色温</dt><dd>${nb.tint > 0.55 ? '偏老' : nb.tint < 0.25 ? '年轻' : '中年'}</dd></div>`;

    body.append(kind, title, p, meta);

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '飞入这片星云';
    btn.onclick = () => focusOn(nb.x, nb.y, nb.r);
    body.appendChild(btn);
  }

  function showGalaxyPanel(c) {
    const panel = $('panel');
    const body = $('panelBody');
    panel.hidden = false;
    body.innerHTML = '';

    const kind = document.createElement('div');
    kind.className = 'kind';
    kind.textContent = '星系';
    const title = document.createElement('h1');
    title.className = 'title';
    title.textContent = c.name;
    const p = document.createElement('div');
    p.className = 'path';
    p.textContent = c.root;

    const meta = document.createElement('dl');
    meta.className = 'meta';
    meta.innerHTML = `
      <div><dt>总质量</dt><dd>${fmtSize(c.size)}</dd></div>
      <div><dt>恒星数</dt><dd>${c.count.toLocaleString()}</dd></div>`;

    body.append(kind, title, p, meta);

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '飞入这个星系';
    btn.onclick = () => focusOn(c.x, c.y, c.r);
    body.appendChild(btn);

    const rm = document.createElement('button');
    rm.className = 'btn';
    rm.style.marginTop = '8px';
    rm.style.background = 'transparent';
    rm.style.color = '#8b9199';
    rm.textContent = '从宇宙中移除';
    rm.onclick = () => removeGalaxy(c.root);
    body.appendChild(rm);
  }

  /* ---------------------------------------------------------- 事件 */

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, cx: U.cam.x, cy: U.cam.y, moved: false };
    canvas.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    pointer = { x: e.clientX, y: e.clientY };
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        U.cam.x = drag.cx - dx / U.cam.z;
        U.cam.y = drag.cy - dy / U.cam.z;
        U.target = null;
        markDirty();
      }
      return;
    }
    if (!U.loaded) return;
    setHover(hitTest(e.clientX, e.clientY));
  });

  window.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    canvas.classList.remove('dragging');
    if (wasDrag) return;

    $('results').hidden = true;
    const h = hitTest(e.clientX, e.clientY);
    if (!h) {
      $('panel').hidden = true;
      U.selected = null;
      markDirty();
      return;
    }
    if (h.kind === 'file') {
      U.selected = h.star;
      openViewer(h.f, h.star);
    } else if (h.kind === 'nebula') {
      U.selected = null;
      showNebulaPanel(h.nebula);
    } else if (h.kind === 'system') {
      U.selected = null;
      focusOn(h.system.x, h.system.y, h.system.r * 2.6);
      toast('★ ' + h.system.name + ' · ' + h.system.count + ' 个文件');
    } else {
      U.selected = null;
      showGalaxyPanel(h.core);
    }
    markDirty();
  });

  canvas.addEventListener('dblclick', (e) => {
    const h = hitTest(e.clientX, e.clientY);
    if (h?.kind === 'file') {
      api(`/api/open?path=${encodeURIComponent(absOf(h.star))}`).catch((err) => toast(err.message));
    } else if (h?.kind === 'nebula') {
      focusOn(h.nebula.x, h.nebula.y, h.nebula.r);
    } else if (h?.kind === 'system') {
      focusOn(h.system.x, h.system.y, h.system.r * 2.6);
    } else if (h?.kind === 'galaxy') {
      focusOn(h.core.x, h.core.y, h.core.r);
    }
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const before = screenToWorld(e.clientX, e.clientY);
    const factor = Math.exp(-e.deltaY * 0.0016);
    U.cam.z = clamp(U.cam.z * factor, 0.02, 12);
    const after = screenToWorld(e.clientX, e.clientY);
    U.cam.x += before.x - after.x;
    U.cam.y += before.y - after.y;
    U.target = null;
    markDirty();
  }, { passive: false });

  window.addEventListener('resize', resize);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('viewer').hidden) { closeViewer(); return; }
      if (!$('results').hidden) { $('results').hidden = true; $('search').blur(); return; }
      $('panel').hidden = true;
      U.selected = null;
      markDirty();
      return;
    }
    if (e.key === '/' && document.activeElement !== $('search')) {
      e.preventDefault();
      $('search').focus();
      $('search').select();
    }
  });

  let searchTimer = null;
  $('search').addEventListener('input', (e) => {
    U.query = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { applySearch(); updateStats(); }, 90);
  });

  $('search').addEventListener('keydown', (e) => {
    const list = U.searchHits || [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.length) { U.activeHit = Math.min(U.activeHit + 1, Math.min(list.length, 60) - 1); refreshActive(); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.length) { U.activeHit = Math.max(U.activeHit - 1, 0); refreshActive(); }
    } else if (e.key === 'Enter') {
      const hit = list[U.activeHit];
      if (!hit) return;
      e.preventDefault();
      if (e.shiftKey) openViewer(hit.f, hit.star);
      else locateStar(hit.star, hit.f);
    }
  });

  $('closePanel').onclick = () => { $('panel').hidden = true; U.selected = null; markDirty(); };
  $('fit').onclick = () => fitAll();
  $('rescan').onclick = async () => {
    const roots = U.galaxies.map((g) => g.root);
    for (const r of roots) await addGalaxy(r, { refresh: true, focus: false }).catch(() => {});
    fitAll();
    toast('星系已重新巡天');
  };

  /* ---------------------------------------------------------- UI */

  function updateStats() {
    const files = U.galaxies.reduce((a, g) => a + g.stats.files, 0);
    const size = U.galaxies.reduce((a, g) => a + g.stats.totalSize, 0);
    const el = $('stats');
    el.innerHTML = '';
    if (U.query) {
      const m = document.createElement('span');
      m.innerHTML = `命中 <b>${U.matches.toLocaleString()}</b> 个`;
      el.append(m);
    }
    const s1 = document.createElement('span');
    s1.innerHTML = `<b>${files.toLocaleString()}</b> 颗星`;
    const s2 = document.createElement('span');
    s2.innerHTML = `<b>${fmtSize(size)}</b>`;
    el.append(s1, s2);
  }

  function renderBars() {
    const bar = $('galaxyBar');
    bar.innerHTML = '';
    for (const g of U.galaxies) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      const dot = document.createElement('i');
      dot.style.background = '#e0b072';
      const label = document.createElement('span');
      label.textContent = g.label;
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = '移除这个星系';
      x.onclick = (e) => { e.stopPropagation(); removeGalaxy(g.root); };
      chip.append(dot, label, x);
      chip.onclick = () => {
        const c = U.cores.find((c) => c.root === g.root);
        if (c) focusOn(c.x, c.y, c.r);
      };
      bar.appendChild(chip);
    }
    if (U.galaxies.length) {
      const add = document.createElement('button');
      add.className = 'chip add';
      add.textContent = '+';
      add.title = '添加星系';
      add.onclick = () => showPicker();
      bar.appendChild(add);
    }
  }

  /* ---------------------------------------------------------- 选择器 */

  async function showPicker() {
    const el = $('picker');
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('on'));
    const list = $('pickList');
    list.innerHTML = '<div class="pick-note">正在探测可用位置…</div>';

    let candidates = [];
    let home = HOME_PATH || '';
    try {
      const data = await api('/api/suggest');
      candidates = data.candidates || [];
      home = data.home || home;
      HOME_PATH = home;
    } catch (e) {
      list.innerHTML = '<div class="pick-note">探测失败：' + e.message + '</div>';
      return;
    }

    list.innerHTML = '';
    candidates.forEach((c) => {
      const card = document.createElement('button');
      card.className = 'pick-card';
      const t = document.createElement('div');
      t.className = 'pick-title';
      t.textContent = c.label;
      const p = document.createElement('div');
      p.className = 'pick-path';
      p.textContent = home ? c.path.replace(home, '~') : c.path;
      card.append(t, p);
      card.onclick = async () => {
        hidePicker();
        if (U.galaxies.some((g) => g.root === c.path)) return;
        try { await addGalaxy(c.path); } catch (e) { toast(e.message); }
      };
      list.appendChild(card);
    });

    if (!U.galaxies.length && HOME_PATH) {
      const all = document.createElement('button');
      all.className = 'pick-card wide';
      const t = document.createElement('div');
      t.className = 'pick-title';
      t.textContent = '整个主目录 — 把一切都装进一个星系';
      const p = document.createElement('div');
      p.className = 'pick-path';
      p.textContent = HOME_PATH.replace(HOME_PATH, '~') + ' · 文件很多，第一次会慢一些';
      all.append(t, p);
      all.onclick = async () => {
        hidePicker();
        try { await addGalaxy(HOME_PATH); } catch (e) { toast(e.message); }
      };
      list.appendChild(all);
    }
  }

  function hidePicker() {
    const el = $('picker');
    el.classList.remove('on');
    setTimeout(() => { el.hidden = true; }, 180);
  }

  /* ---------------------------------------------------------- 加载态 */

  let loadingDepth = 0;
  function showLoading(text) {
    loadingDepth++;
    const el = $('loading');
    el.hidden = false;
    el.classList.remove('done');
    el.textContent = text;
  }
  function hideLoading() {
    loadingDepth = Math.max(0, loadingDepth - 1);
    if (loadingDepth > 0) return;
    const el = $('loading');
    el.classList.add('done');
    setTimeout(() => { el.hidden = true; }, 480);
  }

  /* ---------------------------------------------------------- 主循环 */

  function frame() {
    const moved = stepCamera();
    if (moved) dirty = true;
    if (dirty) {
      dirty = false;
      try { draw(); } catch (e) { console.error(e); }
    }
    requestAnimationFrame(frame);
  }

  async function boot() {
    resize();
    requestAnimationFrame(frame);

    $('pickClose').onclick = hidePicker;
    $('pickGo').onclick = async () => {
      const p = $('pickPath').value.trim();
      if (!p) return;
      hidePicker();
      try { await addGalaxy(p); } catch (e) { toast(e.message); }
    };
    $('pickPath').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('pickGo').click();
    });
    const gain = $('gain');
    gain.value = String(Math.round(U.gain * 100));
    gain.addEventListener('input', (e) => {
      U.gain = Number(e.target.value) / 100;
      localStorage.setItem('cosmos.gain', String(U.gain));
      markDirty();
    });

    $('addGalaxy').onclick = () => showPicker();

    $('viewerClose').onclick = closeViewer;
    $('viewerQuick').onclick = () => {
      if (!nativeBridge('quicklook', U.viewerAbs)) toast('「快速预览」在桌面 App 里可用');
    };
    $('viewerReveal').onclick = () => {
      if (nativeBridge('reveal', U.viewerAbs)) return;
      api(`/api/reveal?path=${encodeURIComponent(U.viewerAbs)}`).catch((e) => toast(e.message));
    };
    $('viewerOpen').onclick = () => {
      api(`/api/open?path=${encodeURIComponent(U.viewerAbs)}`).catch((e) => toast(e.message));
    };

    // 探测 home，供选择器显示
    api('/api/suggest').then(({ home }) => {
      HOME_PATH = home;
      $('pickPath').placeholder = '或粘贴任意绝对路径，如 ~/code、/Volumes/SSD';
    }).catch(() => {});

    // 被别的应用嵌入时（SuperWorkStation 的星图 tab），目录由宿主给
    const params = new URLSearchParams(location.search);
    const embed = params.get('embed') === '1';
    if (embed) document.body.classList.add('embed');

    let roots = storedRoots();
    const rp = params.get('roots');
    if (rp) {
      try {
        const parsed = JSON.parse(rp);
        if (Array.isArray(parsed)) roots = parsed.filter((x) => typeof x === 'string' && x);
      } catch {
        roots = rp.split(',').map((x) => x.trim()).filter(Boolean);
      }
    }

    if (!roots.length) {
      if (embed) {
        const el2 = $('loading');
        el2.hidden = false;
        el2.textContent = '这个工作区还没有添加本地目录';
        return;
      }
      showPicker();
      return;
    }
    showLoading('正在恢复上次的宇宙…');
    for (const r of roots) {
      try { await addGalaxy(r, { focus: false }); } catch (e) { console.warn(e); }
    }
    hideLoading();
    U.loaded = true;
    rebuild();
    updateStats();
    renderBars();
    fitAll();
    setTimeout(() => $('hint').classList.add('fade'), 9000);
  }

  boot();
})();
