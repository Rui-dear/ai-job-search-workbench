// ============================================================
// 前端 AI 接入测试：抽取 index.html 中真实的 escHtml / tryAIMatch /
// renderAIMatch / saveMatchSnapshot / matchSaveButton 源码，
// 在 vm 中用 mock fetch / Store / $ 验证降级、渲染安全与保存快照。
// 用法：node scripts/test-frontend-ai.cjs
// ============================================================

const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('index.html', 'utf8');
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

const src = ['escHtml', 'tryAIMatch', 'renderAIMatch', 'saveMatchSnapshot', 'matchSaveButton'].map(extractFunction).join('\n');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '   ' + detail); }
}

function buildSandbox() {
  let pendingTimer = null;
  let lastHtml = '';
  const store = {};
  let lastSet = null;
  const toasts = [];
  const sandbox = {
    fetch: null,
    AbortController,
    setTimeout: (fn) => { pendingTimer = fn; return 1; },   // 捕获定时器回调，便于手动触发超时
    clearTimeout: () => { pendingTimer = null; },
    AI_LEVEL_CLS: { 强: 'high', 中: 'mid', 弱: 'low' },
    $: (sel) => ({ value: '负责产品运营的演示JD', set innerHTML(v) { lastHtml = v; }, get innerHTML() { return lastHtml; } }),
    Store: {
      get: (k, def) => (k in store ? store[k] : def),
      set: (k, v) => { store[k] = v; lastSet = { k, v }; return true; },
    },
    getResumeText: () => '演示简历内容（虚构）',
    toast: (msg, type) => { toasts.push({ msg, type }); },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, getPendingTimer: () => pendingTimer, getHtml: () => lastHtml, getStore: () => store, getLastSet: () => lastSet, getToasts: () => toasts };
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
  console.log('== 前端 AI 接入测试 ==\n');

  // ---- tryAIMatch ----
  {
    const { sandbox, getPendingTimer } = buildSandbox();
    sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ source: 'ai', data: AI_DATA }) });
    let r = await sandbox.tryAIMatch(RESUME, JD);
    ok('tryAIMatch 成功 -> ok:true + data', r.ok === true && r.data.matchScore === 78, JSON.stringify(r).slice(0, 80));

    sandbox.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'NO_KEY' }) });
    r = await sandbox.tryAIMatch(RESUME, JD);
    ok('非200 -> ok:false + reason=NO_KEY', r.ok === false && r.reason === 'NO_KEY', JSON.stringify(r));

    sandbox.fetch = async () => ({ ok: true, status: 200, json: async () => ({ foo: 1 }) });
    r = await sandbox.tryAIMatch(RESUME, JD);
    ok('200 无 source=ai -> BAD_RESPONSE', r.ok === false && r.reason === 'BAD_RESPONSE', JSON.stringify(r));

    sandbox.fetch = async () => { throw new Error('network down'); };
    r = await sandbox.tryAIMatch(RESUME, JD);
    ok('网络异常 -> NETWORK', r.ok === false && r.reason === 'NETWORK', JSON.stringify(r));

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
    const evil = Object.assign({}, AI_DATA, {
      summary: '<img src=x onerror=alert(1)>',
      coreRequirements: ['<script>x</script>'],
      matches: [{ requirement: 'a<b', evidence: '<b>ev</b>', level: '强' }],
    });
    sandbox.renderAIMatch(evil);
    let html = getHtml();
    ok('renderAIMatch 转义 summary', html.includes('&lt;img src=x') && !html.includes('<img src=x'), '');
    ok('renderAIMatch 转义 requirement', html.includes('a&lt;b') && !html.includes('<script>x</script>'), '');

    sandbox.renderAIMatch(AI_DATA);
    html = getHtml();
    ok('AI 徽标存在', html.includes('ai-source-badge') && html.includes('AI 分析'), '');
    ok('匹配分数渲染', html.includes('78%'), '');
    ok('结构化区块渲染', html.includes('岗位核心要求') && html.includes('匹配优势') && html.includes('能力差距') && html.includes('面试问题'), '');
    ok('AI 结果含保存按钮', html.includes('saveMatchSnapshot()'), '');

    sandbox.renderAIMatch(Object.assign({}, AI_DATA, { matchScore: 999 }));
    ok('matchScore>100 被夹为 100', getHtml().includes('100%'), '');
    sandbox.renderAIMatch(Object.assign({}, AI_DATA, { matchScore: -5 }));
    ok('matchScore<0 被夹为 0', getHtml().includes('0%'), '');
  }

  // ---- saveMatchSnapshot ----
  {
    const { sandbox, getLastSet, getToasts, getStore } = buildSandbox();
    sandbox.lastMatchResult = { source: 'ai', data: { matchScore: 80, summary: '匹配良好' } };
    sandbox.saveMatchSnapshot();
    const set = getLastSet();
    ok('保存快照 -> 写入 aiMatchHistory', set && set.k === 'aiMatchHistory', JSON.stringify(set));
    const arr = set && set.v;
    ok('快照含 source/resume/jd/result', Array.isArray(arr) && arr[0].source === 'ai' && typeof arr[0].resume === 'string' && typeof arr[0].jd === 'string' && arr[0].result.matchScore === 80, JSON.stringify(arr && arr[0]));
    ok('保存成功 toast', getToasts().some((t) => t.type === 'ok'), '');

    // 上限 20 条
    getStore().aiMatchHistory = Array.from({ length: 20 }, (_, i) => ({ i }));
    sandbox.saveMatchSnapshot();
    const capped = getLastSet().v;
    ok('快照历史上限 20 条', Array.isArray(capped) && capped.length === 20, 'len=' + (capped && capped.length));
  }

  // ---- 演示数据标注（安全） ----
  ok('演示简历已标注', mainScript.includes('【演示简历'), '');
  ok('演示JD已标注', mainScript.includes('【演示岗位JD'), '');
  ok('演示数据不含手机号', !/1[3-9]\d{9}/.test(mainScript.match(/const DEMO_RESUME=`[\s\S]*?`;/)[0]), '');

  console.log(`\n== 结果: ${pass} PASS / ${fail} FAIL ==`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('测试异常', e); process.exit(2); });
