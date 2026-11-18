'use strict';

/**
 * server.js —— Local Cosmos 的本地服务。
 * 零依赖：只用 node 内置模块。
 *
 * 核心约定：用户指定哪些目录要变成「星系」，服务端就扫哪些，
 * 扫过的结果落盘缓存，下次秒开。不主动全盘扫描。
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { scan } = require('./scanner');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = process.env.COSMOS_CACHE || path.join(__dirname, '.cache');
const HOME = os.homedir();
const PORT = process.env.PORT === undefined ? 5178 : Number(process.env.PORT);
const OPEN_BROWSER = process.argv.includes('--open');

/** 已加载的星系：root 绝对路径 -> { data, at } */
const galaxies = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg'
};

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'heic', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aiff']);

/* ---------------------------------------------------------------- utils */

function sendJSON(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const accept = res.req?.headers?.['accept-encoding'] || '';
  const gz = accept.includes('gzip') && body.length > 2048;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(gz ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {})
  });
  res.end(gz ? zlib.gzipSync(body, { level: 4 }) : body);
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function expandPath(p) {
  if (typeof p !== 'string' || !p.length) return null;
  return path.resolve(p.replace(/^~(?=$|\/|\\)/, HOME));
}

/** 文件只能预览 / 打开在「家目录」或某个已加载星系内，防止越界乱读 */
function insideAllowed(abs) {
  if (isInside(HOME, abs)) return true;
  for (const root of galaxies.keys()) if (isInside(root, abs)) return true;
  return false;
}

function cacheFile(root) {
  const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 16);
  return path.join(CACHE_DIR, hash + '.json');
}

/* ---------------------------------------------------------------- 星系 */

async function loadGalaxy(rawPath, { refresh } = {}) {
  const abs = expandPath(rawPath);
  if (!abs) throw new Error('路径无效');

  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('不是有效目录：' + rawPath);

  const hit = galaxies.get(abs);
  if (hit && !refresh) return hit.data;

  // 内存 → 磁盘缓存 → 真扫
  if (!refresh) {
    try {
      const cached = JSON.parse(await fsp.readFile(cacheFile(abs), 'utf8'));
      if (cached.root === abs && Date.now() - cached.scannedAt < 12 * 3600e3) {
        galaxies.set(abs, { data: cached, at: Date.now() });
        return cached;
      }
    } catch { /* 没缓存就走扫描 */ }
  }

  const data = await scan(abs);
  galaxies.set(abs, { data, at: Date.now() });
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    await fsp.writeFile(cacheFile(abs), JSON.stringify(data));
  } catch { /* 缓存写失败不影响使用 */ }
  return data;
}

/** 给前端的轻量摘要（不含文件列表），用于启动时恢复上次的宇宙 */
function summarize(d) {
  return {
    root: d.root,
    label: d.label,
    scannedAt: d.scannedAt,
    stats: d.stats,
    nebulas: d.nebulas.map((n) => ({ name: n.name, size: n.size, count: n.count })),
    looseCount: d.looseFiles.length
  };
}

async function handleSuggest(res) {
  const candidates = [
    ['主目录', HOME],
    ['桌面', path.join(HOME, 'Desktop')],
    ['文档', path.join(HOME, 'Documents')],
    ['下载', path.join(HOME, 'Downloads')],
    ['图片', path.join(HOME, 'Pictures')],
    ['影片', path.join(HOME, 'Movies')],
    ['音乐', path.join(HOME, 'Music')],
    ['代码', path.join(HOME, 'up')],
    ['我的项目', path.join(HOME, 'code')]
  ];
  const out = [];
  for (const [label, p] of candidates) {
    const st = await fsp.stat(p).catch(() => null);
    if (st?.isDirectory()) out.push({ label, path: p });
  }
  // 外置 / 网络卷
  const vols = await fsp.readdir('/Volumes').catch(() => []);
  for (const v of vols) {
    const p = path.join('/Volumes', v);
    const st = await fsp.stat(p).catch(() => null);
    if (st?.isDirectory() && p !== '/Volumes/Macintosh HD') out.push({ label: v, path: p, volume: true });
  }
  sendJSON(res, 200, { home: HOME, candidates: out });
}

/* ---------------------------------------------------------------- 文件 */

async function handlePreview(query, res) {
  const abs = expandPath(query.path);
  if (!abs || !insideAllowed(abs)) return sendJSON(res, 400, { error: '路径越界' });

  const st = await fsp.stat(abs).catch(() => null);
  if (!st) return sendJSON(res, 404, { error: '文件不存在' });
  if (!st.isFile()) return sendJSON(res, 400, { error: '不是文件' });

  const ext = path.extname(abs).slice(1).toLowerCase();
  const rawUrl = `/api/raw?path=${encodeURIComponent(query.path)}`;
  if (IMAGE_EXT.has(ext)) return sendJSON(res, 200, { kind: 'image', ext, size: st.size, url: rawUrl });
  if (ext === 'pdf') return sendJSON(res, 200, { kind: 'pdf', ext, size: st.size, url: rawUrl });
  if (VIDEO_EXT.has(ext)) return sendJSON(res, 200, { kind: 'video', ext, size: st.size, url: rawUrl });
  if (AUDIO_EXT.has(ext)) return sendJSON(res, 200, { kind: 'audio', ext, size: st.size, url: rawUrl });

  const limit = Math.min(Number(query.lines) || 120, 2000);
  const size = Math.min(st.size, 256 * 1024);
  const buf = Buffer.alloc(size);
  const fh = await fsp.open(abs, 'r');
  let read = 0;
  try {
    ({ bytesRead: read } = await fh.read(buf, 0, size, 0));
  } finally {
    await fh.close();
  }
  const head = buf.subarray(0, read);
  if (head.includes(0)) {
    return sendJSON(res, 200, { kind: 'binary', size: st.size });
  }
  const lines = head.toString('utf8').split('\n');
  sendJSON(res, 200, {
    kind: 'text',
    ext,
    size: st.size,
    truncated: read < st.size || lines.length > limit,
    content: lines.slice(0, limit).join('\n')
  });
}

async function handleRaw(query, res) {
  const abs = expandPath(query.path);
  if (!abs || !insideAllowed(abs)) return sendJSON(res, 400, { error: '路径越界' });
  const st = await fsp.stat(abs).catch(() => null);
  if (!st?.isFile() || st.size > 24 * 1024 * 1024) {
    return sendJSON(res, 400, { error: '文件过大或不是文件' });
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': 'private, max-age=60'
  });
  fs.createReadStream(abs).pipe(res);
}

function handleReveal(query, res) {
  const abs = expandPath(query.path);
  if (!abs || !insideAllowed(abs)) return sendJSON(res, 400, { error: '路径越界' });
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, ['-R', abs], (err) => {
    if (err) sendJSON(res, 500, { error: err.message });
    else sendJSON(res, 200, { ok: true });
  });
}

function handleOpen(query, res) {
  const abs = expandPath(query.path);
  if (!abs || !insideAllowed(abs)) return sendJSON(res, 400, { error: '路径越界' });
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [abs], (err) => {
    if (err) sendJSON(res, 500, { error: err.message });
    else sendJSON(res, 200, { ok: true });
  });
}

/* ---------------------------------------------------------------- 路由 */

const server = http.createServer(async (req, res) => {
  res.req = req;
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const query = Object.fromEntries(url.searchParams);

  try {
    if (url.pathname === '/api/suggest') return await handleSuggest(res);

    if (url.pathname === '/api/galaxies') {
      return sendJSON(res, 200, { galaxies: [...galaxies.values()].map((g) => summarize(g.data)) });
    }

    if (url.pathname === '/api/galaxy' && req.method !== 'DELETE') {
      const data = await loadGalaxy(query.path, { refresh: query.refresh === '1' });
      return sendJSON(res, 200, data);
    }

    if (url.pathname === '/api/galaxy' && req.method === 'DELETE') {
      const abs = expandPath(query.path);
      galaxies.delete(abs);
      if (abs) await fsp.rm(cacheFile(abs), { force: true }).catch(() => {});
      return sendJSON(res, 200, { ok: true });
    }

    if (url.pathname === '/api/preview') return await handlePreview(query, res);
    if (url.pathname === '/api/raw') return await handleRaw(query, res);
    if (url.pathname === '/api/open') return handleOpen(query, res);
    if (url.pathname === '/api/reveal') return handleReveal(query, res);

    // 静态资源
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const abs = path.join(PUBLIC_DIR, rel);
    if (!isInside(PUBLIC_DIR, abs)) { res.writeHead(403).end('forbidden'); return; }
    const body = await fsp.readFile(abs).catch(() => null);
    if (!body) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(body);
  } catch (err) {
    if (!res.headersSent) sendJSON(res, 500, { error: String((err && err.message) || err) });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  // 原生壳靠这一行拿到实际端口（PORT=0 时由系统分配）
  console.log(`COSMOS_PORT=${port}`);
  console.log(`\n  ✦ Local Cosmos  ${url}\n`);
  if (OPEN_BROWSER) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(cmd, [url]);
  }
});
