/* ===========================================================================
   theme.js —— 主题引擎
   ---------------------------------------------------------------------------
   做三件事：
   1. 把种子色转成 OKLCH，生成 M3 的 tone 阶梯（0–100）
   2. 按 Material 3 的 color role 映射表，输出浅色/深色两套角色
   3. 把结果写到 :root 的 CSS 变量上，并持久化用户选择

   为什么用 OKLCH 而不是 HSL：
   HSL 的 L 不感知人眼亮度，同一 L 下不同色相看起来明暗差很多，
   生成出的 container 会有的刺眼有的发灰。OKLCH 的 L 接近感知亮度，
   更接近 M3 规范里用 L* 的分档方式。

   Chroma 处理：M3 的 tone 越高/越低，饱和度都该收敛，
   否则浅色 container 会过艳、深色 surface 会发脏。
   =========================================================================== */

(function () {
  'use strict';

  // ---------------- 颜色数学 ----------------
  function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '').trim();
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    if (full.length !== 6) return { r: 63, g: 111, b: 237 }; // 兜底蓝
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }

  function rgbToOklch(r, g, b) {
    const rl = srgbToLinear(r / 255);
    const gl = srgbToLinear(g / 255);
    const bl = srgbToLinear(b / 255);

    const l = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl;
    const m = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl;
    const s = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl;

    const l_ = Math.cbrt(l);
    const m_ = Math.cbrt(m);
    const s_ = Math.cbrt(s);

    const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
    const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
    const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

    const C = Math.hypot(a, bb);
    let H = (Math.atan2(bb, a) * 180) / Math.PI;
    if (H < 0) H += 360;
    return { L: L, C: C, H: H };
  }

  // M3 的 tone 越高/越低，chroma 都要收敛，避免过艳或发脏
  function chromaAt(baseC, tone) {
    const d = Math.abs(tone - 40) / 60; // 以 tone 40 为饱和峰值
    const factor = 1 - 0.62 * Math.min(1, d);
    return Math.max(0.004, baseC * factor);
  }

  function toneCss(h, baseC, tone) {
    const L = Math.max(0, Math.min(1, tone / 100));
    const C = chromaAt(baseC, tone);
    return 'oklch(' + L.toFixed(4) + ' ' + C.toFixed(4) + ' ' + h.toFixed(2) + ')';
  }

  // ---------------- 角色生成 ----------------
  // 一张 M3 角色表：角色名 → [tonalPaletteKey, toneLight, toneDark]
  // tonalPaletteKey: p(primary) / s(secondary) / t(tertiary) / n(neutral) / nv(neutralVariant) / e(error)
  const ROLES = {
    primary: ['p', 40, 80],
    onPrimary: ['p', 100, 20],
    primaryContainer: ['p', 90, 30],
    onPrimaryContainer: ['p', 10, 90],

    secondary: ['s', 40, 80],
    onSecondary: ['s', 100, 20],
    secondaryContainer: ['s', 90, 30],
    onSecondaryContainer: ['s', 10, 90],

    tertiary: ['t', 40, 80],
    onTertiary: ['t', 100, 20],
    tertiaryContainer: ['t', 90, 30],
    onTertiaryContainer: ['t', 10, 90],

    error: ['e', 40, 80],
    onError: ['e', 100, 20],
    errorContainer: ['e', 90, 30],
    onErrorContainer: ['e', 10, 90],

    surface: ['n', 100, 7],
    onSurface: ['n', 10, 92],
    surfaceVariant: ['nv', 92, 30],
    onSurfaceVariant: ['nv', 38, 76],

    surfaceContainerLowest: ['n', 100, 4],
    surfaceContainerLow: ['n', 98, 11],
    surfaceContainer: ['n', 96, 13],
    surfaceContainerHigh: ['n', 94, 17],
    surfaceContainerHighest: ['n', 92, 22],

    outline: ['nv', 50, 60],
    outlineVariant: ['nv', 80, 30],

    inverseSurface: ['n', 20, 90],
    inverseOnSurface: ['n', 95, 20],
    inversePrimary: ['p', 80, 40],

    surfaceTint: ['p', 40, 80],
  };

  // 调色板可调参数：secondary 更灰，neutral 几乎无彩，tertiary 换个色相
  // 参考 DSH Desktop 的观感：底色是中性白/浅灰，不随种子色偏色；
  // 种子色只作用在 primary/secondary/tertiary 上（按钮、进度、选中态）。
  function buildPalettes(seed) {
    const rgb = hexToRgb(seed);
    const o = rgbToOklch(rgb.r, rgb.g, rgb.b);
    const h = o.H;
    return {
      p: { h: h, c: Math.max(0.06, Math.min(o.C, 0.16)) }, // 主色：保留种子饱和度
      s: { h: h, c: Math.max(0.02, Math.min(o.C * 0.45, 0.07)) }, // 次色：明显降饱和
      t: { h: (h + 60) % 360, c: Math.max(0.04, Math.min(o.C * 0.8, 0.12)) }, // 第三色：色相偏转
      n: { h: h, c: 0.0008 }, // 中性：几乎纯灰，不偏色
      nv: { h: h, c: 0.005 }, // 中性变体：极淡
      e: { h: 25, c: 0.16 }, // 错误色固定红
    };
  }

  function buildRoleVars(seed, dark) {
    const pal = buildPalettes(seed);
    const out = {};
    for (const role of Object.keys(ROLES)) {
      const [key, toneLight, toneDark] = ROLES[role];
      const tone = dark ? toneDark : toneLight;
      out['--md-sys-color-' + role] = toneCss(pal[key].h, pal[key].c, tone);
    }
    return out;
  }

  // 反色：用于在任意色块上算前景色
  function onColor(seed, tone) {
    const pal = buildPalettes(seed);
    return toneCss(pal.p.h, pal.p.c, tone);
  }

  // ---------------- 应用 ----------------
  const STORAGE_KEY = 'cx-theme-v1';

  function readState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return s && typeof s === 'object' ? s : null;
    } catch (e) {
      return null;
    }
  }

  function writeState(s) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch (e) {
      /* ignore */
    }
  }

  let state = {
    seed: '#4C6FFF',
    dark: false,
    contrast: 'standard',
  };

  function apply(next) {
    state = Object.assign({}, state, next || {});
    const root = document.documentElement;
    const vars = buildRoleVars(state.seed, state.dark);

    for (const k of Object.keys(vars)) root.style.setProperty(k, vars[k]);
    // 品牌色本身（用于少量需要原色的地方，比如焦点环的柔光）
    root.style.setProperty('--app-seed', state.seed);
    root.style.setProperty('--app-elevation-1', 'var(--md-sys-elevation-level1)');

    root.setAttribute('data-theme', state.dark ? 'dark' : 'light');
    // Windows 11 Mica 在浅色/深色下透出的底色不同
    root.setAttribute('data-mica', state.dark ? 'dark' : 'light');

    // 同步 meta theme-color（标题栏）
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = vars['--md-sys-color-surface'] || '#fff';

    writeState(state);
    document.dispatchEvent(new CustomEvent('theme-change', { detail: Object.assign({}, state) }));
    return state;
  }

  function init() {
    const saved = readState();
    if (saved) state = Object.assign(state, saved);
    // 首次进入跟随系统
    if (!saved) {
      try {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) state.dark = true;
      } catch (e) {
        /* ignore */
      }
    }
    // 原型预览用：?dark=1 &seed=0F9D58，方便直接看某套配色
    try {
      const u = new URLSearchParams(location.search);
      if (u.get('dark') === '1') state.dark = true;
      if (u.get('dark') === '0') state.dark = false;
      if (u.get('seed')) state.seed = '#' + String(u.get('seed')).replace(/^#/, '');
    } catch (e) {
      /* ignore */
    }
    apply(state);
  }

  window.CxTheme = {
    init: init,
    apply: apply,
    get: function () {
      return Object.assign({}, state);
    },
    setSeed: function (hex) {
      return apply({ seed: hex });
    },
    setDark: function (dark) {
      return apply({ dark: !!dark });
    },
    toggle: function () {
      return apply({ dark: !state.dark });
    },
    // 供组件计算"在某色上应该用什么前景色"
    onColor: onColor,
    // 调试：导出当前种子下的完整色调阶梯
    palette: function () {
      const pal = buildPalettes(state.seed);
      const out = {};
      for (const key of Object.keys(pal)) {
        out[key] = {};
        for (let t = 0; t <= 100; t += 10) out[key][t] = toneCss(pal[key].h, pal[key].c, t);
      }
      return out;
    },
  };
})();
