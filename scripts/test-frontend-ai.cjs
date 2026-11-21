// ============================================================
// B2 前端 AI 接入测试：抽取 app.html 中真实的 escHtml / tryAIMatch /
// renderAIMatch 源码，在 vm 中用 mock fetch 验证降级与渲染安全。
// 用法：node scripts/test-frontend-ai.cjs
// ============================================================

const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('app.html', 'utf8');
const mainScript = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)][0][1];

// 从源码中按花括号配对抽取函数体（测的是真实代码，不是重写）
function extractFunction(name) {
  const idx = mainScript.indexOf('function ' + name);
  if (idx < 0) throw new Error('未找到函数: ' + name);
  // 若声明前有 async 关键字，一并纳入，否则 await 会报语法错误
  let start = idx;
  const prefix = mainScript.slice(0, idx);
  const am = prefix.match(/\basync\s*$/);
  if (am) start = idx - am[0].length;
  let i = mainScript.indexOf('{', idx);
  let depth = 0;
  for (; i < mainScript.length; i++) {
    if (mainScript[i] === '{') depth++;
    else if (mainScript[i] === '}') { depth--; if (depth === 0) return mainScript.slice(start, i + 1); }
  }
  throw new Error('函数括号不匹配: ' + name);
}

const src = [extractFunction('escHtml'), extractFunction('tryAIMatch'), extractFunction('renderAIMatch')].join('\n');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '   ' + detail); }
}

function buildSandbox() {
  let pendingTimer = null;
  let lastHtml = '';
  const sandbox = {
    fetch: null,
    AbortController,
    setTimeout: (fn) => { pendingTimer = fn; return 1; },   // 捕获定时器回调，便于手动触发超时
    clearTimeout: () => { pendingTimer = null; },
    AI_LEVEL_CLS: { 强: 'high', 中: 'mid', 弱: 'low' },
    $: () => ({ set innerHTML(v) { lastHtml = v; }, get innerHTML() { return lastHtml; } }),
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, getPendingTimer: () => pendingTimer, getHtml: () => lastHtml };
}

const RESUME = '我在XX公司实习，负责用户增长与数据分析。'.repeat(10);
const JD = '负责产品运营，要求数据分析、活动策划、跨团队协作。'.repeat(10);
const AI_DATA = {
  summary: '整体匹配良好', matchScore: 78,
  coreRequirements: ['数据分析', '用户增长'],
  matches: [{ requirement: '数据分析', evidence: '简历：负责数据分析', level: '强' }],
  gaps: [{ requirement: '活动策划', missing: '简历未提及活动策划' }],
  suggestions: ['量化成果'], interviewQuestions: ['说说你的增长项目'],
};

async function run() {
  console.log('== B2 前端 AI 接入测试 ==\n');

  // ---- tryAIMatch ----
  {
    const { sandbox, getPendingTimer } = buildSandbox();
    // 1. 成功
    sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ source: 'ai', data: AI_DATA }) });
    let r = await sandbox.tryAIMatch(RESUME, JD);
    ok('tryAIMatch 成功 -> ok:true + data', r.ok === true && r.data.matchScore === 78, JSON.stringify(r).slice(0, 80));

    // 2. 非 200 + error 码
    sandbox.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'NO_KEY' }) });
    r = await sandbox.tryAIMatch(RESUME, JD);
    ok('非200 -> ok:false + reason=NO_KEY', r.ok === false && r.reason === 'NO_KEY', JSON.stringify(r));

    // 3. 200 但结构不对
    sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ foo: 1 }) });
    r = await sandbox.tryAIMatch(RESUME, JD);
    ok('200 无 source=ai -> BAD_RESPONSE', r.ok === false && r.reason === 'BAD_RESPONSE', JSON.stringify(r));

    // 4. 网络错误
    sandbox.fetch = async () => { throw new Error('network down'); };
    r = await sandbox.tryAIMatch(RESUME, JD);
    ok('网络异常 -> NETWORK', r.ok === false && r.reason === 'NETWORK', JSON.stringify(r));

    // 5. 超时（手动触发 abort）
    sandbox.fetch = (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    const p = sandbox.tryAIMatch(RESUME, JD);
    const t = getPendingTimer();
    if (typeof t === 'function') t(); else ok('超时测试：定时器已注册', false, 'pendingTimer 不是函数');
    r = await p;
    ok('超时(abort) -> TIMEOUT', r.ok === false && r.reason === 'TIMEOUT', JSON.stringify(r));
  }

  // ---- renderAIMatch ----
  {
    const { sandbox, getHtml } = buildSandbox();
    // 6. XSS 转义
    const evil = Object.assign({}, AI_DATA, {
      summary: '<img src=x onerror=alert(1)>',
      coreRequirements: ['<script>x</script>'],
      matches: [{ requirement: 'a<b', evidence: '<b>ev</b>', level: '强' }],
    });
    sandbox.renderAIMatch(evil);
    let html = getHtml();
    ok('renderAIMatch 转义 summary', html.includes('&lt;img src=x') && !html.includes('<img src=x'), '');
    ok('renderAIMatch 转义 requirement', html.includes('a&lt;b') && !html.includes('<script>x</script>'), '');

    // 7. AI 徽标 + 分数 + 结构
    sandbox.renderAIMatch(AI_DATA);
    html = getHtml();
    ok('AI 徽标存在', html.includes('ai-source-badge') && html.includes('AI 分析'), '');
    ok('匹配分数渲染', html.includes('78%'), '');
    ok('结构化区块渲染', html.includes('岗位核心要求') && html.includes('匹配优势') && html.includes('能力差距') && html.includes('面试问题'), '');

    // 8. matchScore 边界夹取
    sandbox.renderAIMatch(Object.assign({}, AI_DATA, { matchScore: 999 }));
    html = getHtml();
    ok('matchScore>100 被夹为 100', html.includes('100%'), '');
    sandbox.renderAIMatch(Object.assign({}, AI_DATA, { matchScore: -5 }));
    html = getHtml();
    ok('matchScore<0 被夹为 0', html.includes('0%'), '');
  }

  console.log(`\n== 结果: ${pass} PASS / ${fail} FAIL ==`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('测试异常', e); process.exit(2); });
