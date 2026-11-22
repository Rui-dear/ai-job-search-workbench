// ============================================================
// 构建 dist 发布目录（Netlify 用）：只复制前端静态文件。
// 绝不复制后端源码（api/ netlify/）、开发脚本（scripts/）、
// 备份（backup/）、文档、环境变量模板等，避免泄露到公开静态目录。
// 用法：node scripts/build-dist.cjs
// ============================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// index.html 自包含（CSS/JS 内联，无本地静态资源引用），仅此一个文件。
// 若未来新增本地静态资源（图片/独立 css/js），在此白名单内补充。
const STATIC_FILES = ['index.html'];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

for (const f of STATIC_FILES) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) {
    console.error('[build-dist] 缺少静态文件: ' + f);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(DIST, f));
}

console.log('[build-dist] dist 已生成，包含: ' + STATIC_FILES.join(', '));
