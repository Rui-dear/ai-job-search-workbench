// ============================================================
// Netlify 适配层测试：验证 netlify/functions/match.js 能正确
// 把 Netlify event 转成 api/match.js 的 (req,res)，并把结果转回
// Netlify 返回格式；同时覆盖缺少 Key / 空输入 / 超长 / 非法 /
// 限流 / 成功等关键路径。用 mock fetch 验证，不触发真实网络。
// 用法：node scripts/test-netlify-adapter.cjs
// ============================================================

const { handler } = require('../netlify/functions/match.js');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '   ' + detail); }
}

function event(method, bodyObj, headers = {}) {
  return {
    httpMethod: method,
    headers: { 'x-forwarded-for': '203.0.113.50', ...headers },
    body: bodyObj == null ? null : JSON.stringify(bodyObj),
  };
}

const VALID = { resume: 'x'.repeat(40), jd: 'y'.repeat(30) };
const origFetch = global.fetch;
const origEnv = { ...process.env };

function resetEnv() {
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_TIMEOUT_MS;
  delete process.env.RATE_LIMIT_MAX;
  delete process.env.RATE_LIMIT_WINDOW_MS;
}

async function run() {
  console.log('== Netlify 适配层测试 ==\n');
  resetEnv();

  // ---- 返回格式 ----
  {
    const r = await handler(event('POST', VALID));
    ok('返回 {statusCode,headers,body} 结构', typeof r.statusCode === 'number' && typeof r.headers === 'object' && typeof r.body === 'string', JSON.stringify(r).slice(0, 80));
    ok('Content-Type 为 application/json', /application\/json/.test(r.headers['Content-Type'] || ''), r.headers['Content-Type']);
    ok('含 CORS 头', r.headers['Access-Control-Allow-Origin'] === '*', JSON.stringify(r.headers));
  }

  // ---- 缺少 API Key（环境变量从服务端读取）----
  {
    resetEnv();
    const r = await handler(event('POST', VALID));
    ok('无 Key -> 503 NO_KEY', r.statusCode === 503 && JSON.parse(r.body).error === 'NO_KEY', r.body);
  }

  // ---- 空输入 ----
  {
    resetEnv();
    let r = await handler(event('POST', { resume: '', jd: '' }));
    ok('空输入 -> 400 BAD_INPUT', r.statusCode === 400 && JSON.parse(r.body).error === 'BAD_INPUT', r.body);
    r = await handler(event('POST', null));
    ok('无 body -> 400 BAD_INPUT', r.statusCode === 400, r.body);
  }

  // ---- 非法请求（非法 JSON body）----
  {
    resetEnv();
    const r = await handler({ httpMethod: 'POST', headers: { 'x-forwarded-for': '203.0.113.51' }, body: 'not-a-json{{{' });
    ok('非法 JSON -> 400', r.statusCode === 400, r.body);
  }

  // ---- 超长输入 ----
  {
    resetEnv();
    let r = await handler(event('POST', { resume: 'x'.repeat(20001), jd: 'y'.repeat(30) }));
    ok('简历超长 -> 400', r.statusCode === 400 && JSON.parse(r.body).error === 'BAD_INPUT', r.body.slice(0, 80));
    r = await handler(event('POST', { resume: 'x'.repeat(40), jd: 'y'.repeat(10001) }));
    ok('JD 超长 -> 400', r.statusCode === 400, r.body.slice(0, 80));
  }

  // ---- 方法不允许 ----
  {
    resetEnv();
    const r = await handler(event('GET', null));
    ok('GET -> 405', r.statusCode === 405, r.body);
  }

  // ---- OPTIONS 预检 ----
  {
    resetEnv();
    const r = await handler(event('OPTIONS', null));
    ok('OPTIONS -> 204', r.statusCode === 204, JSON.stringify(r));
  }

  // ---- 成功（mock fetch 返回结构化 JSON）----
  {
    resetEnv();
    process.env.LLM_API_KEY = 'sk-test-fake';
    process.env.LLM_BASE_URL = 'https://example.invalid';
    global.fetch = async (url, opts) => {
      ok('fetch 请求头含 Bearer', opts.headers.Authorization === 'Bearer sk-test-fake', opts.headers.Authorization);
      ok('fetch 请求体含 resume/jd', opts.body.includes('x'.repeat(40)) && opts.body.includes('y'.repeat(30)), '');
      // 模拟 OpenAI 兼容接口的真实包装格式（模型输出在 choices[0].message.content）
      return { ok: true, status: 200, text: async () => JSON.stringify({
        id: 'chatcmpl-123', object: 'chat.completion', model: 'deepseek-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({
          summary: '整体匹配良好', matchScore: 78,
          coreRequirements: ['数据分析'],
          matches: [{ requirement: '数据分析', evidence: '负责数据分析', level: '强' }],
          gaps: [{ requirement: '活动策划', missing: '简历未体现' }],
          suggestions: ['量化成果'], interviewQuestions: ['说说你的项目'],
        }) }, finish_reason: 'stop' }],
      }) };
    };
    const r = await handler(event('POST', VALID));
    ok('成功 -> 200 source=ai', r.statusCode === 200 && JSON.parse(r.body).source === 'ai', r.body.slice(0, 120));
    ok('成功 -> matchScore 解析', JSON.parse(r.body).data.matchScore === 78, r.body);
    global.fetch = origFetch;
  }

  // ---- 限流（RATE_LIMIT_MAX=1，同一 IP 第 2 次触发 429）----
  {
    resetEnv();
    process.env.RATE_LIMIT_MAX = '1';
    const h = { 'x-forwarded-for': '203.0.113.99' };
    await handler(event('POST', VALID, h));            // 第 1 次：不触发（count=1）
    const r = await handler(event('POST', VALID, h));  // 第 2 次：count=2 > 1 -> 429
    ok('限流 -> 第 2 次 429 RATE_LIMIT', r.statusCode === 429 && JSON.parse(r.body).error === 'RATE_LIMIT', r.body);
    resetEnv();
  }

  // 恢复现场
  global.fetch = origFetch;
  for (const k of Object.keys(process.env)) { if (!(k in origEnv)) delete process.env[k]; }
  Object.assign(process.env, origEnv);

  console.log(`\n== 结果: ${pass} PASS / ${fail} FAIL ==`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('测试异常', e); process.exit(2); });
