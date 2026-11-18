'use strict';

/**
 * scanner.js —— 把一棵目录树扫描成「星图数据」。
 *
 * 目标不是精确的磁盘用量统计（du 干得更好），而是给渲染器一份
 * 「足够真实、足够快」的宇宙：每个文件是一颗星，体积是它的质量，
 * 修改时间是它的年龄。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

// 这些目录会让星图变成一团毫无意义的噪声，默认不进去。
const SKIP_DIRS = new Set([
  'node_modules', 'bower_components', '.git', '.svn', '.hg',
  '.venv', 'venv', 'env', 'virtualenv', '__pycache__', 'site-packages',
  '.cache', '.npm', '.pnpm-store', '.yarn', '.gradle', '.m2', '.cargo', '.rustup',
  'dist', 'build', 'target', 'out', '.next', '.nuxt', '.svelte-kit',
  'DerivedData', 'Pods', '.Trash', '.Spotlight-V100', '.fseventsd',
  'coverage', '.nyc_output', '.pytest_cache', '.mypy_cache', '.tox',
  '.idea', '.vscode-test', 'obj', 'bin', 'Release', 'Debug',
  'Library', 'Caches', '.local', '.docker'
]);

// 无意义的系统垃圾文件
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);

// 星点颜色由扩展名决定，前端只需要扩展名。
// 这里只负责把大小归一化，颜色在渲染层定义（视觉归视觉）。

/** 限制并发的 stat，避免瞬间打开上万次文件句柄 */
function makeLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

/**
 * @param {string} root 绝对路径
 * @param {object} opts
 * @param {number} opts.maxFiles  最多收录多少个文件（超出后停止）
 * @param {number} opts.deadlineMs 硬性时间上限，超时返回已完成的部分
 */
async function scan(root, opts = {}) {
  const maxFiles = opts.maxFiles ?? 90000;
  const deadline = Date.now() + (opts.deadlineMs ?? 25000);
  const limit = makeLimiter(96);

  const files = [];
  let dirs = 0;
  let skippedDirs = 0;
  let totalSize = 0;
  let truncated = false;
  let timedOut = false;

  async function walk(absDir, relDir) {
    if (truncated) return;
    if (Date.now() > deadline) { timedOut = true; return; }

    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // 没权限 / 目录在扫描途中消失，跳过即可
    }
    dirs++;

    const subs = [];
    for (const ent of entries) {
      const name = ent.name;
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = path.join(absDir, name);

      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) { skippedDirs++; continue; }
        subs.push([abs, rel]);
        continue;
      }
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      if (SKIP_FILES.has(name)) continue;
      if (files.length >= maxFiles) { truncated = true; break; }

      // stat 拿大小和修改时间；符号链接用 stat 跟随，坏链就忽略
      let st;
      try {
        st = await limit(() => fs.stat(abs));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      const dot = name.lastIndexOf('.');
      files.push({
        p: rel,
        n: name,
        s: st.size,
        t: Math.round(st.mtimeMs),
        e: dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
      });
      totalSize += st.size;
    }

    await Promise.all(subs.map(([a, r]) => walk(a, r)));
  }

  const startedAt = Date.now();
  await walk(root, '');

  // 一级子目录 = 星云（nebula）；根目录下散落的文件 = 星系核周围的孤星
  const nebulas = new Map();
  const looseFiles = [];
  for (const f of files) {
    const slash = f.p.indexOf('/');
    if (slash === -1) {
      looseFiles.push(f);
      continue;
    }
    const key = f.p.slice(0, slash);
    let neb = nebulas.get(key);
    if (!neb) {
      neb = { name: key, size: 0, count: 0, files: [] };
      nebulas.set(key, neb);
    }
    neb.files.push(f);
    neb.size += f.s;
    neb.count++;
  }

  return {
    root,
    label: path.basename(root) || root,
    scannedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    stats: {
      files: files.length,
      dirs,
      totalSize,
      skippedDirs,
      truncated,
      timedOut
    },
    nebulas: [...nebulas.values()].sort((a, b) => b.size - a.size),
    looseFiles
  };
}

module.exports = { scan, SKIP_DIRS };
