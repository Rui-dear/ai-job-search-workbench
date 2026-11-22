// ============================================================
// B1 网关测试：直接 require api/match.js，用 mock fetch 验证
// 校验 / 限流 / 异常路径 / 成功路径。
// 用法：node scripts/test-gateway.cjs
// 不依赖真实 API Key；真实模型调用测试见 B3。
// ============================================================

const handler = require('../api/match.js');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '   ' + detail); }
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = s; },
  };
}

let ipSeq = 0;
function makeReq(overrides = {}) {
  ipSeq++;
  return Object.assign({
    method: 'POST',
    headers: { 'x-forwarded-for': `10.0.0.${ipSeq}` },
    socket: { remoteAddress: '127.0.0.1' },
    body: {},
  }, overrides);
}

async function call(overrides = {}) {
  const req = makeReq(overrides);
  const res = makeRes();
  await handler(req, res);
  let body = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch (e) { body = { raw: res.body }; }
  return { status: res.statusCode, body };
}

const VALID_JD = '负责产品运营与用户增长，要求具备数据分析、活动策划、跨团队协作能力，本科及以上学历。'.repeat(4);
const VALID_RESUME = '我在XX公司实习，负责用户增长，通过活动策划带来20%增长，具备数据分析能力。'.repeat(4);
const VALID_AI_JSON = () => JSON.stringify({
  summary: '整体匹配良好', matchScore: 78,
  coreRequirements: ['数据分析', '用户增长'],
  matches: [{ requirement: '数据分析', evidence: '简历：具备数据分析能力', level: '强' }],
  gaps: [{ requirement: '活动策划', missing: '简历未提及活动策划相关经历' }],
  suggestions: ['把数据结果量化'], interviewQuestions: ['说说你的增长项目'],
});

async function main() {
  console.log('== B1 网关测试 ==\n');

  // 1. OPTIONS 预检
  let r = await call({ method: 'OPTIONS' });
  ok('OPTIONS -> 204', r.status === 204, 'got ' + r.status);

  // 2. 非 POST
  r = await call({ method: 'GET' });
  ok('GET -> 405', r.status === 405, 'got ' + r.status);

  // 3. 缺输入
  r = await call({ body: {} });
  ok('缺 resume/jd -> 400 BAD_INPUT', r.status === 400 && r.body.error === 'BAD_INPUT', 'got ' + r.status);

  // 4. 输入过短
  r = await call({ body: { resume: 'abc', jd: 'def' } });
  ok('输入过短 -> 400', r.status === 400, 'got ' + r.status);

  // 5. 简历超长
  r = await call({ body: { resume: 'x'.repeat(20001), jd: VALID_JD } });
  ok('简历超长 -> 400', r.status === 400, 'got ' + r.status);

  // 6. 无 Key
  const savedKey = process.env.LLM_API_KEY;
  delete process.env.LLM_API_KEY;
  r = await call({ body: { resume: VALID_RESUME, jd: VALID_JD } });
  ok('无 Key -> 503 NO_KEY', r.status === 503 && r.body.error === 'NO_KEY', 'got ' + r.status + ' ' + JSON.stringify(r.body));

  // 7-10 有 Key，mock fetch
  process.env.LLM_API_KEY = 'test-key';

  // 7. 成功路径（并校验发出的请求体与鉴权头）
  global.fetch = async (url, opts) => {
    const sent = JSON.parse(opts.body);
    ok('成功路径：请求体含 model + 2 条 messages', !!sent.model && Array.isArray(sent.messages) && sent.messages.length === 2, JSON.stringify(Object.keys(sent)));
    ok('成功路径：Authorization 带 Key', opts.headers && opts.headers.Authorization === 'Bearer test-key', JSON.stringify(opts.headers));
    ok('成功路径：URL 指向 /chat/completions', String(url).endsWith('/chat/completions'), String(url));
    return { ok: true, status: 200, text: async () => VALID_AI_JSON() };
  };
  r = await call({ body: { resume: VALID_RESUME, jd: VALID_JD } });
  ok('成功 -> 200 source=ai', r.status === 200 && r.body.source === 'ai', 'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
  ok('成功 -> 结构化 data', r.status === 200 && r.body.data && r.body.data.matchScore === 78 && Array.isArray(r.body.data.matches), 'data=' + JSON.stringify(r.body.data));
  ok('成功 -> matchScore 夹在 0-100', r.body.data && r.body.data.matchScore >= 0 && r.body.data.matchScore <= 100);

  // 7b. 成功路径：OpenAI 兼容包装格式（choices[0].message.content）
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      id: 'chatcmpl-123', object: 'chat.completion', model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: VALID_AI_JSON() }, finish_reason: 'stop' }],
    }),
  });
  r = await call({ body: { resume: VALID_RESUME, jd: VALID_JD } });
  ok('OpenAI 包装格式 -> 正确解包 content', r.status === 200 && r.body.data && r.body.data.matchScore === 78 && r.body.data.summary === '整体匹配良好', 'data=' + JSON.stringify(r.body.data));

  // 7c. 匹配分健壮解析：模型可能输出 "82分" / "约75左右" / 0.82 等非纯数字写法
  const scoreCases = [['82', 82], ['"82"', 82], ['"82分"', 82], ['"约75左右"', 75], ['0.82', 82], ['0', 0]];
  for (const [rawScore, want] of scoreCases) {
    global.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"summary":"s","matchScore":' + rawScore + ',"coreRequirements":[],"matches":[],"gaps":[],"suggestions":[],"interviewQuestions":[]}' } }] }),
    });
    const rr = await call({ body: { resume: VALID_RESUME, jd: VALID_JD } });
    ok('匹配分 ' + rawScore + ' -> ' + want, rr.status === 200 && rr.body.data && rr.body.data.matchScore === want, 'got ' + JSON.stringify(rr.body.data && rr.body.data.matchScore));
  }
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"summary":"s","coreRequirements":[],"matches":[],"gaps":[],"suggestions":[],"interviewQuestions":[]}' } }] }),
  });
  r = await call({ body: { resume: VALID_RESUME, jd: VALID_JD } });
  ok('matchScore 缺失 -> 0', r.status === 200 && r.body.data && r.body.data.matchScore === 0, 'got ' + JSON.stringify(r.body.data));

  // 8. 上游非 200
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
  r = await call({ body: { resume: VALID_RESUME, jd: VALID_JD } });
  ok('上游 401 -> 502 UPSTREAM', r.status === 502 && r.body.error === 'UPSTREAM', 'got ' + r.status);

  // 9. 返回非 JSON
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '这是一段不是JSON的回复' });
  r = await call({ body: { resume: VALID_RESUME, jd: VALID_JD } });
  ok('非 JSON -> 502 BAD_RESPONSE', r.status === 502 && r.body.error === 'BAD_RESPONSE', 'got ' + r.status);

  // 10. 超时
  process.env.LLM_TIMEOUT_MS = '100';
  global.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  r = await call({ body: { resume: VALID_RESUME, jd: VALID_JD } });
  ok('超时 -> 504 TIMEOUT', r.status === 504 && r.body.error === 'TIMEOUT', 'got ' + r.status + ' ' + JSON.stringify(r.body));
  delete process.env.LLM_TIMEOUT_MS;

  // 11. 限流：同 IP 连续超过 RATE_LIMIT_MAX
  process.env.RATE_LIMIT_MAX = '3';
  global.fetch = async () => ({ ok: true, status: 200, text: async () => VALID_AI_JSON() });
  const fixedIp = '10.0.0.254';
  let lastStatus = 0, lastError = null;
  for (let i = 0; i < 5; i++) {
    const rr = await call({ headers: { 'x-forwarded-for': fixedIp }, body: { resume: VALID_RESUME, jd: VALID_JD } });
    lastStatus = rr.status; lastError = rr.body.error;
  }
  ok('限流 -> 第4次起 429 RATE_LIMIT', lastStatus === 429 && lastError === 'RATE_LIMIT', 'last=' + lastStatus + ' ' + lastError);
  delete process.env.RATE_LIMIT_MAX;

  process.env.LLM_API_KEY = savedKey;

  console.log(`\n== 结果: ${pass} PASS / ${fail} FAIL ==`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试异常', e); process.exit(2); });
