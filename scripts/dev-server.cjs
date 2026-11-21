// ============================================================
// 本地开发服务器（零依赖）：静态托管前端 + /api/match 路由到网关。
// 用法：node scripts/dev-server.cjs
// 可选：先在仓库根目录建 .env 填 LLM_API_KEY，即可本地体验真实 AI。
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const matchHandler = require('../api/match.js');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, '..');

// 极简 .env 加载（不覆盖已存在的环境变量）
function loadEnv() {
  const fp = path.join(ROOT, '.env');
  if (!fs.existsSync(fp)) return;
  for (const line of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnv();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // API 路由（模拟 Vercel：把 JSON body 解析进 req.body 后交给网关）
  if (url.pathname === '/api/match') {
    try {
      if (req.method === 'POST') {
        let data = '';
        for await (const c of req) data += c;
        try { req.body = data ? JSON.parse(data) : {}; } catch (e) { req.body = {}; }
      }
      await matchHandler(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'SERVER_ERROR', message: String(e && e.message || e) }));
    }
    return;
  }
  // 静态文件
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  let file = path.join(ROOT, decodeURIComponent(p));
  if (url.pathname === '/' && !fs.existsSync(file)) file = path.join(ROOT, 'app.html');
  if (!file.startsWith(ROOT)) { res.statusCode = 403; res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`本地服务已启动：http://localhost:${PORT}`);
  console.log(`LLM_API_KEY=${process.env.LLM_API_KEY ? '已配置（真实 AI）' : '未配置（AI 请求将返回 503，前端自动走规则兜底）'}`);
});
