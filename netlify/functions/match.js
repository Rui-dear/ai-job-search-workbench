// ============================================================
// AI 简历×JD 匹配 网关（Netlify Function 适配层）
// ------------------------------------------------------------
// 复用 api/match.js 的全部业务逻辑（输入校验 / 限流 / 超时 /
// 调用 OpenAI 兼容 LLM / 结构化解析 / 错误映射），仅做一层
// 协议适配：把 Netlify 的 event 对象转成 api/match.js 期望的
// Vercel 风格 (req, res)，再把结果转回 Netlify 的返回格式。
//
// 好处：不复制业务代码，api/match.js 仍是单一事实来源；
// 前端 /api/match 请求经 netlify.toml 重写到此函数，无需改动。
// ============================================================

const matchHandler = require('../../api/match.js');

// Netlify event -> Vercel 风格 req
function makeReq(event) {
  const headers = (event && event.headers) || {};
  let body = {};
  const raw = event && event.body;
  if (raw) {
    try { body = JSON.parse(raw); } catch (e) { body = {}; } // 解析失败按空输入处理，网关返回 400
  }
  return {
    method: (event && event.httpMethod) || 'GET',
    headers,
    // 已解析的 body：api/match.js 的 readBody 检测到 req.body 为对象后直接返回
    body,
    socket: { remoteAddress: headers['client-ip'] || headers['x-forwarded-for'] || undefined },
  };
}

// Vercel 风格 res -> 收集状态码 / 头 / 响应体
function makeRes() {
  return {
    statusCode: 200,
    _headers: {},
    _body: '',
    setHeader(k, v) { this._headers[k] = v; },
    end(chunk) { this._body = (chunk == null ? '' : String(chunk)); },
  };
}

exports.handler = async function handler(event) {
  const req = makeReq(event);
  const res = makeRes();
  await matchHandler(req, res);
  return {
    statusCode: res.statusCode,
    headers: res._headers,
    body: res._body || '',
  };
};
