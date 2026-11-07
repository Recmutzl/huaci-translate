// 划词翻译 background.js —— 翻译代理：绕开网页跨域限制，隐藏 API Key
// 支持两个引擎：baidu（百度翻译开放平台） / deepseek（DeepSeek 大模型）

const BAIDU_API = 'https://fanyi-api.baidu.com/api/trans/vip/translate';
const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';
const REQUEST_TIMEOUT = 15000; // 单次请求超时 15 秒

// ---------- 译文缓存（30 秒） ----------
// 反复划同一段文字时直接命中缓存，秒出译文、不重复请求
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // key: engine:text -> { text, ts }

function getCache(engine, text) {
  const hit = cache.get(engine + ':' + text);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.text;
  return null;
}

function setCache(engine, text, result) {
  cache.set(engine + ':' + text, { text: result, ts: Date.now() });
  // 缓存超过 200 条时，清掉最旧的一半，防止内存膨胀
  if (cache.size > 200) {
    [...cache.keys()].slice(0, 100).forEach((k) => cache.delete(k));
  }
}

// ---------- 工具 ----------
function fetchWithTimeout(url, options = {}, timeout = REQUEST_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, { ...options, signal: ctrl.signal })
    .finally(() => clearTimeout(t));
}

// 标准 MD5（百度签名用；Chrome 的 crypto.subtle 不支持 MD5，需自行实现）
// 基于 RFC 1321，输入按 UTF-8 字节处理（中文也能正确签名）
function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const bitLenLo = (bytes.length * 8) >>> 0;
  const bitLenHi = Math.floor(bytes.length * 8 / 0x100000000);

  const padLen = (56 - ((bytes.length + 1) % 64) + 64) % 64;
  const total = bytes.length + 1 + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLenLo, true);
  dv.setUint32(total - 4, bitLenHi, true);

  const K = [];
  for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const F = (x, y, z) => ((x & y) | (~x & z)) >>> 0;
  const G = (x, y, z) => ((x & z) | (y & ~z)) >>> 0;
  const H = (x, y, z) => (x ^ y ^ z) >>> 0;
  const I = (x, y, z) => (y ^ (x | ~z)) >>> 0;
  const RL = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let off = 0; off < total; off += 64) {
    const M = [];
    for (let j = 0; j < 16; j++) M.push(dv.getUint32(off + j * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = F(B, C, D); g = i; }
      else if (i < 32) { f = G(B, C, D); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = H(B, C, D); g = (3 * i + 5) % 16; }
      else { f = I(B, C, D); g = (7 * i) % 16; }
      const tmp = D;
      D = C; C = B;
      B = (B + RL((A + f + K[i] + M[g]) >>> 0, S[(i >> 4) * 4 + (i % 4)])) >>> 0;
      A = tmp;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const toHex = (v) => {
    const b = new DataView(new ArrayBuffer(4));
    b.setUint32(0, v, true);
    return Array.from(new Uint8Array(b.buffer)).map((x) => x.toString(16).padStart(2, '0')).join('');
  };
  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}

// ---------- 百度翻译 ----------
async function translateWithBaidu(text, cfg) {
  if (!cfg.baiduAppid || !cfg.baiduKey) {
    throw new Error('未配置百度翻译 APP ID / 密钥，请到扩展设置页填写');
  }
  const salt = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // 签名用的是原始文本（未 URL 编码）
  const sign = md5(cfg.baiduAppid + text + salt + cfg.baiduKey);
  const params = new URLSearchParams({
    q: text, from: 'auto', to: 'zh',
    appid: cfg.baiduAppid, salt, sign
  });

  let data;
  try {
    const resp = await fetchWithTimeout(`${BAIDU_API}?${params.toString()}`);
    data = await resp.json();
  } catch (err) {
    throw new Error('百度接口请求失败（网络或超时）：' + (err.name === 'AbortError' ? '超时' : err.message));
  }

  if (data.error_code) {
    const map = {
      '52003': '签名错误，请检查 APP ID / 密钥',
      '54001': '签名错误，请检查 APP ID / 密钥',
      '54003': '访问频率受限（百度免费版限 1 次/秒），请稍候',
      '54004': '账户余额不足',
      '58003': 'IP 不在百度白名单内，请在百度开放平台添加服务器 IP',
      '58001': '不支持的语言类型'
    };
    throw new Error(map[data.error_code] || (data.error_msg + ' (' + data.error_code + ')'));
  }
  if (!data.trans_result || !data.trans_result.length) {
    throw new Error('百度返回结果为空');
  }
  return data.trans_result.map((r) => r.dst).join('\n');
}

// ---------- DeepSeek ----------
async function translateWithDeepSeek(text, cfg, maxTokens = 512) {
  if (!cfg.deepseekKey) {
    throw new Error('未配置 DeepSeek API Key，请到扩展设置页填写');
  }
  const body = {
    model: 'deepseek-v4-flash',
    messages: [
      {
        role: 'system',
        content: '你是一个专业翻译引擎。请把用户输入的文本翻译成简体中文。只输出译文本身，不要任何解释、注释或多余内容；如果原文是中文，直接原样输出。'
      },
      { role: 'user', content: text }
    ],
    temperature: 0.3,
    max_tokens: maxTokens,
    stream: false
  };

  let data;
  try {
    const resp = await fetchWithTimeout(DEEPSEEK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.deepseekKey
      },
      body: JSON.stringify(body)
    });
    data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('HTTP ' + resp.status);
      throw new Error('DeepSeek 接口错误：' + msg);
    }
  } catch (err) {
    if (err && err.message && err.message.startsWith('DeepSeek 接口错误')) throw err;
    throw new Error('DeepSeek 接口请求失败（网络或超时）：' + (err && err.name === 'AbortError' ? '超时' : (err && err.message) || err));
  }

  const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!out) throw new Error('DeepSeek 返回结果为空');
  return out.trim();
}

// ---------- 批量分段翻译（全文模式专用，固定走 DeepSeek） ----------
// segments: [{id, text}]，内部并发 ≤4 路；逐段返回结果，顺序与输入一致
async function translateSegments(segments, cfg) {
  const out = new Array(segments.length);
  const CONCURRENT = 4;
  let next = 0;

  async function worker() {
    while (next < segments.length) {
      const idx = next++;
      try {
        const t = await translateWithDeepSeek(segments[idx].text, cfg, 1024);
        out[idx] = { id: segments[idx].id, ok: true, text: t };
      } catch (err) {
        out[idx] = { id: segments[idx].id, ok: false, error: (err && err.message) ? err.message : String(err) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENT, segments.length) }, worker));
  return out;
}

// ---------- 消息入口 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.type !== 'translate' && msg.type !== 'translate_batch')) return;

  (async () => {
    const cfg = await chrome.storage.local.get({
      enabled: true,
      engine: 'baidu',
      baiduAppid: '',
      baiduKey: '',
      deepseekKey: ''
    });
    if (!cfg.enabled) throw new Error('插件已停用，请到设置页开启');

    if (msg.type === 'translate_batch') {
      // 全文翻译：固定 DeepSeek（保格式、支持整篇、不占百度 1 次/秒限额）
      if (!cfg.deepseekKey) throw new Error('全文翻译需要 DeepSeek API Key，请到设置页填写');
      const segments = Array.isArray(msg.segments) ? msg.segments : [];
      if (!segments.length) throw new Error('没有可翻译的段落');
      const results = await translateSegments(segments, cfg);
      sendResponse({ ok: true, results });
      return;
    }

    const engine = msg.engine === 'deepseek' ? 'deepseek' : 'baidu';
    const text = String(msg.text || '').trim();
    if (!text) throw new Error('没有可翻译的文本');

    // 命中缓存直接返回
    const cached = getCache(engine, text);
    if (cached) {
      sendResponse({ ok: true, text: cached, engine, cached: true });
      return;
    }

    const result = engine === 'deepseek'
      ? await translateWithDeepSeek(text, cfg)
      : await translateWithBaidu(text, cfg);

    setCache(engine, text, result);
    sendResponse({ ok: true, text: result, engine });
  })().catch((err) => {
    sendResponse({ ok: false, error: (err && err.message) ? err.message : String(err) });
  });

  return true; // 异步响应
});
