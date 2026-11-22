// ============================================================
// AI 简历×JD 匹配 网关（Vercel Function）
// ------------------------------------------------------------
// 职责：托管 API Key（仅存环境变量，永不进前端/Git）→ 校验输入 →
//       调用 OpenAI 兼容 LLM → 返回结构化 JSON。
// 前端拿不到 Key，也拿不到原始模型响应，只拿到结构化匹配结果。
// 规则兜底仍在前端完成，本网关不生成任何“伪 AI”规则结果。
// ============================================================

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 25000;

// 输入长度上限（防滥用 / 控制单次成本）
const MAX_RESUME_CHARS = 20000;
const MAX_JD_CHARS = 10000;

// 模型输出上限（控制成本）
const MAX_TOKENS = 2000;

// 尽力而为的调用保护：按 IP 滑动窗口限流。
// 无状态 serverless 下内存不跨实例共享，仅对同一热实例生效，属“必要保护”，
// 不能替代 Vercel WAF / 网关级限流，但可挡住明显刷量。
const rateMap = new Map();

function hitRateLimit(ip) {
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000; // 默认 10 分钟
  const max = Number(process.env.RATE_LIMIT_MAX) || 10;                         // 默认每窗口 10 次
  const now = Date.now();
  const rec = rateMap.get(ip);
  if (!rec || now - rec.start >= windowMs) {
    rateMap.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > max;
}

const SYSTEM_PROMPT = `你是一名资深求职辅导顾问。根据用户提供的「简历原文」和「岗位 JD 原文」，输出简历与岗位的匹配分析。

严格规则（必须遵守）：
1. 只能使用简历原文中真实存在的内容作为证据；禁止编造简历中不存在的能力、项目或经历。
2. 优势（matches）必须给出「简历原文证据」：引用简历中对应的原句或关键词。
3. 差距（gaps）只表示「简历中未体现」，绝对不要写成「不具备该能力」。
4. 面试问题要针对该岗位 JD 的真实要求，并可追问简历相关经历。
5. 所有输出使用中文。

只输出一个 JSON 对象（不要输出 markdown 代码块、不要输出任何解释性文字），结构如下：
{
  "summary": "一句话总评",
  "matchScore": 0到100的整数,
  "coreRequirements": ["岗位核心要求1", "岗位核心要求2", "…最多6条"],
  "matches": [{"requirement": "岗位要求", "evidence": "简历原文中的证据", "level": "强|中|弱"} …最多6条],
  "gaps": [{"requirement": "岗位要求", "missing": "为什么简历里没有体现/缺哪类证据"} …最多6条],
  "suggestions": ["可执行的简历优化建议" …最多6条],
  "interviewQuestions": ["针对该岗位的面试问题" …最多6条]
}`;

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  // Vercel Node runtime 已对 application/json 自动解析为 req.body
  if (req.body && typeof req.body === 'object') return req.body;
  // 兜底：手动读取（带大小上限，防止超大数据撑爆内存）
  return await new Promise((resolve, reject) => {
    let data = '';
    let done = false;
    const tooLarge = () => { if (!done) { done = true; reject(new Error('TOO_LARGE')); } };
    req.on('data', (c) => { data += c; if (data.length > 40000) tooLarge(); });
    req.on('end', () => { if (!done) { done = true; try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function extractJson(text) {
  const s = String(text || '').trim();
  let t = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) { /* 继续尝试提取 */ }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* 放弃 */ }
  }
  return null;
}

// OpenAI 兼容接口把模型输出包在 choices[0].message.content 里（通常是 JSON 字符串）。
// 这里解包取真正的模型输出文本；若非该结构（如 mock 直接返回 JSON）则原样返回。
function extractContent(text) {
  const s = String(text || '').trim();
  try {
    const wrapper = JSON.parse(s);
    const c = wrapper && wrapper.choices && wrapper.choices[0]
      && wrapper.choices[0].message && wrapper.choices[0].message.content;
    if (typeof c === 'string' && c.trim()) return c;
  } catch (e) { /* 不是 JSON，按原样返回 */ }
  return s;
}

function arr(v, max) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x == null ? '' : x)).map((x) => x.trim()).filter(Boolean).slice(0, max);
}

function parseAndValidate(text) {
  const raw = extractJson(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const matches = (Array.isArray(raw.matches) ? raw.matches : []).slice(0, 6).map((m) => {
    if (m && typeof m === 'object') {
      return {
        requirement: String(m.requirement || '').trim(),
        evidence: String(m.evidence || '').trim(),
        level: /^(强|中|弱)$/.test(m.level) ? m.level : '中',
      };
    }
    return { requirement: '', evidence: '', level: '中' };
  }).filter((m) => m.requirement);
  const gaps = (Array.isArray(raw.gaps) ? raw.gaps : []).slice(0, 6).map((g) => {
    if (g && typeof g === 'object') {
      return { requirement: String(g.requirement || '').trim(), missing: String(g.missing || '').trim() };
    }
    return { requirement: '', missing: '' };
  }).filter((g) => g.requirement);
  const score = Math.max(0, Math.min(100, Math.round(Number(raw.matchScore) || 0)));
  return {
    summary: String(raw.summary || '').trim(),
    matchScore: score,
    coreRequirements: arr(raw.coreRequirements, 6),
    matches,
    gaps,
    suggestions: arr(raw.suggestions, 6),
    interviewQuestions: arr(raw.interviewQuestions, 6),
  };
}

async function callLLM(resume, jd) {
  const key = process.env.LLM_API_KEY;
  if (!key) return { error: 'NO_KEY' };
  const baseUrl = String(process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `【简历原文】\n${resume}\n\n【岗位JD原文】\n${jd}` },
        ],
        temperature: 0.3,
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return { error: 'UPSTREAM', status: resp.status };
    const text = await resp.text();
    const data = parseAndValidate(extractContent(text));
    if (!data) return { error: 'BAD_RESPONSE' };
    return { data };
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) return { error: 'TIMEOUT' };
    return { error: 'UPSTREAM', status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.end();
    return;
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });

  // 调用保护：尽力而为的按 IP 限流
  const ip = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (hitRateLimit(ip)) return json(res, 429, { error: 'RATE_LIMIT' });

  // 输入校验
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'BAD_INPUT', message: '请求体无法解析或过大' }); }
  const resume = String((body && body.resume) || '').trim();
  const jd = String((body && body.jd) || '').trim();
  if (!resume || !jd) return json(res, 400, { error: 'BAD_INPUT', message: '缺少 resume 或 jd' });
  if (resume.length > MAX_RESUME_CHARS || jd.length > MAX_JD_CHARS) return json(res, 400, { error: 'BAD_INPUT', message: '内容超长' });
  if (resume.length < 30 || jd.length < 20) return json(res, 400, { error: 'BAD_INPUT', message: '内容过短' });

  const result = await callLLM(resume, jd);
  if (result.error === 'NO_KEY') return json(res, 503, { error: 'NO_KEY', message: '未配置模型服务，请检查后端环境变量' });
  if (result.error === 'TIMEOUT') return json(res, 504, { error: 'TIMEOUT', message: '模型响应超时' });
  if (result.error === 'BAD_RESPONSE') return json(res, 502, { error: 'BAD_RESPONSE', message: '模型返回格式无法解析' });
  if (result.error === 'UPSTREAM') return json(res, 502, { error: 'UPSTREAM', status: result.status, message: '模型服务调用失败' });
  return json(res, 200, { source: 'ai', data: result.data });
};
