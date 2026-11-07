// 划词翻译 content.js —— 网页侧脚本
// 功能：
//  1) 短句（≤500 字）：选中文字上方弹 toast，自动翻译 / 点击「翻 译」按钮翻译
//  2) 长文 / 全文：右侧滑出侧窗，只展示中文译文（原文看页面本身），段落级双向高亮定位；
//     支持拖拽左缘调宽（上限页面一半）、点击空白收起、悬浮球一键恢复，带收放动效
//  3) toast 在页面滚动 / 缩放时不再消失，而是跟随选区或钉在视口内
(() => {
  'use strict';

  const MAX_LEN = 500;          // 超过此长度的选中文本进入「全文/长文」模式
  const DEBOUNCE_MS = 150;      // 松开鼠标后等待多少毫秒再弹（150ms 既跟手又能防双击误触）
  const ZH_RATIO = 0.3;         // 中文字符占比 ≥ 30% 视为“已经是中文”，不翻译
  const HOST_ID = 'huaci-translate-host';
  const SIDEBAR_ID = 'huaci-translate-sidebar';
  const FLOAT_ID = 'huaci-translate-float';
  const HL_CLASS = 'hc-seg-hi';
  const MAX_SEGS = 60;          // 全文翻译最多分段数
  const BATCH_SIZE = 4;         // 并发翻译的段落数（DeepSeek 高并发，4 路够稳）
  const SBAR_MIN_W = 300;       // 侧窗最小宽度
  const SBAR_MAX_RATIO = 0.5;   // 侧窗最大宽度 = 页面宽度的一半
  const FAIL_HINT = '这一段未能完成翻译，轻点「重新翻译」继续'; // 失败段落上的短提示，详细原因放在「重新翻译」的悬停里

  let config = { enabled: true, auto: true, engine: 'baidu' };
  let timer = null;
  let host = null;              // toast 宿主（Shadow DOM）
  let sidebarHost = null;       // 侧窗宿主（Shadow DOM），收起时其 .panel 变形为悬浮球
  let hiStyleEl = null;         // 页面级高亮样式
  let lastRange = null;         // 最近一次选区的快照（防 mouseup 后选区被清空）
  let sidebarState = null;      // { segs, indexMap, rows[], colsEl, panel, soft }
  let dragState = null;         // 拖拽调宽状态 { startX, startW }
  let mouseDownX = 0, mouseDownY = 0; // 区分点击与拖选
  let hasMouseDown = false;    // 本次鼠标交互是否收到过真实 mousedown（辅助点击只有 mouseup，视为点击）

  // ---------- 配置读取与热更新 ----------
  function loadConfig() {
    chrome.storage.local.get({ enabled: true, auto: true, engine: 'baidu' }, (items) => {
      config.enabled = !!items.enabled;
      config.auto = !!items.auto;
      config.engine = items.engine || 'baidu';
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) config.enabled = !!changes.enabled.newValue;
    if (changes.auto) config.auto = !!changes.auto.newValue;
    if (changes.engine) config.engine = changes.engine.newValue || 'baidu';
  });

  // ---------- 工具函数 ----------
  function getRawSelectedText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    return sel.toString().trim();
  }

  function getSelectedText() {
    return getRawSelectedText().replace(/\s+/g, ' ').trim();
  }

  function isMostlyChinese(text) {
    const zh = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g);
    if (!zh) return false;
    return zh.length / text.length >= ZH_RATIO;
  }

  function getSelectionRect() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    return rect;
  }

  function positionCard(card, rect) {
    const cardRect = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const gap = 10;
    let left = rect.left + rect.width / 2 - cardRect.width / 2;
    let top = rect.top - cardRect.height - gap;
    // 选区上方放不下时，翻到选区下方
    if (top < 8) top = rect.bottom + gap;
    left = Math.max(8, Math.min(left, vw - cardRect.width - 8));
    if (left < 8) left = 8;
    top = Math.max(8, top);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(resp);
      });
    });
  }

  // ---------- Toast 构建 ----------
  function buildHost() {
    const el = document.createElement('div');
    el.id = HOST_ID;
    el.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
    const shadow = el.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .card {
          position: fixed;
          max-width: 340px;
          max-height: 280px;
          overflow-y: auto;
          background: #ffffff;
          color: #0d0d0d;
          border: 1px solid rgba(0,0,0,.08);
          border-radius: 12px;
          box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.10);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          font-size: 14px;
          line-height: 1.65;
          word-break: break-word;
          opacity: 0;
          transform: translateY(5px) scale(.98);
          transition: opacity .12s ease-out, transform .12s ease-out;
        }
        .card.show { opacity: 1; transform: translateY(0) scale(1); }
        .header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 7px 12px; font-size: 12px; color: #6b7280;
          border-bottom: 1px solid rgba(0,0,0,.06);
          user-select: none;
        }
        .body { padding: 12px 14px; }
        .btn {
          display: inline-flex; align-items: center; gap: 5px;
          border: none; border-radius: 8px;
          background: #0d0d0d; color: #fff;
          font-size: 13px; font-weight: 500;
          padding: 8px 16px; cursor: pointer;
          font-family: inherit;
          transition: background .12s ease;
        }
        .btn:hover { background: #1f2937; }
        .btn:active { background: #000; }
        .btn-ghost {
          display: inline-flex; align-items: center;
          border: 1px solid #d4d4d8; border-radius: 8px;
          background: #fff; color: #0d0d0d;
          font-size: 13px; font-weight: 500;
          padding: 6px 14px; cursor: pointer;
          font-family: inherit;
          transition: background .12s ease, border-color .12s ease;
        }
        .btn-ghost:hover { background: #f4f4f5; border-color: #a1a1aa; }
        .close {
          border: none; background: transparent; color: #9ca3af;
          font-size: 13px; cursor: pointer; padding: 2px 4px; line-height: 1;
          border-radius: 4px; transition: color .12s ease, background .12s ease;
        }
        .close:hover { color: #0d0d0d; background: rgba(0,0,0,.05); }
        .err { color: #dc2626; }
        .meta { color: #6b7280; font-size: 12px; margin-top: 6px; }
        .loading {
          display: inline-flex; align-items: center; gap: 8px;
          color: #6b7280; font-size: 13px;
        }
        .spinner {
          width: 12px; height: 12px;
          border: 2px solid #e5e7eb; border-top-color: #0d0d0d;
          border-radius: 50%;
          animation: huaci-spin .7s linear infinite;
        }
        @keyframes huaci-spin { to { transform: rotate(360deg); } }
      </style>
      <div class="card">
        <div class="header">
          <span>划词翻译</span>
          <button class="close" title="关闭 (Esc)">✕</button>
        </div>
        <div class="body"></div>
      </div>
    `;
    return el;
  }

  function showAt(rect, text) {
    close();
    host = buildHost();
    document.body.appendChild(host);

    const card = host.shadowRoot.querySelector('.card');
    const body = host.shadowRoot.querySelector('.body');

    positionCard(card, rect);
    requestAnimationFrame(() => {
      positionCard(card, rect);
      card.classList.add('show');
    });

    host.shadowRoot.querySelector('.close').addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });

    if (config.auto) {
      requestTranslate(text, body, card, rect);
    } else {
      // 自动弹关闭 → 显示“翻 译”按钮，点击才翻译
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:center;gap:10px;';
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = '翻 译';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        requestTranslate(text, body, card, rect);
      });
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = '选中文字';
      wrap.appendChild(btn);
      wrap.appendChild(meta);
      body.appendChild(wrap);
    }
  }

  function requestTranslate(text, body, card, rect) {
    body.textContent = '';
    const loading = document.createElement('div');
    loading.className = 'loading';
    loading.innerHTML = '<span class="spinner"></span>翻译中…';
    body.appendChild(loading);

    chrome.runtime.sendMessage({ type: 'translate', text, engine: config.engine }, (resp) => {
      body.textContent = '';
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        const p = document.createElement('div');
        p.className = 'err';
        p.textContent = '扩展出错：' + lastErr.message;
        body.appendChild(p);
        positionCard(card, rect);
        return;
      }
      if (resp && resp.ok) {
        const p = document.createElement('div');
        p.textContent = resp.text;
        body.appendChild(p);
        const meta = document.createElement('div');
        meta.className = 'meta';
        const src = text.length > 40 ? text.slice(0, 40) + '…' : text;
        meta.textContent = '原文：' + src + ' · ' + (resp.engine === 'deepseek' ? 'DeepSeek' : '百度');
        body.appendChild(meta);
        // 短句 toast 上提供「翻译全文」快捷入口
        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;justify-content:flex-end;margin-top:10px;';
        const btn = document.createElement('button');
        btn.className = 'btn-ghost';
        btn.textContent = '翻译全文';
        btn.title = '翻译当前阅读区域全文，在右侧侧窗中对照查看';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          close();
          fullTranslateFromSelection(true);
        });
        footer.appendChild(btn);
        body.appendChild(footer);
      } else {
        const p = document.createElement('div');
        p.className = 'err';
        p.textContent = (resp && resp.error) ? '翻译失败：' + resp.error : '翻译失败，请到扩展设置页检查 API Key';
        body.appendChild(p);
      }
      positionCard(card, rect);
    });
  }

  // ---------- Toast 关闭 ----------
  function close() {
    if (host) {
      host.remove();
      host = null;
    }
  }

  // ================= 全文翻译（侧窗） =================

  // 主内容容器识别：优先 article/main，其次选区向上找文本最多的祖先，兜底 body 下文本最重的块
  function findContainer(range) {
    if (range) {
      const main = document.querySelector('article, main, [role="main"]');
      if (main) {
        const ca = range.commonAncestorContainer;
        if (ca === main || (ca.nodeType === 1 && main.contains(ca)) || (ca.nodeType === 3 && main.contains(ca.parentNode))) {
          return main;
        }
      }
      let node = range.commonAncestorContainer;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
      // 全选 / 选区覆盖整个文档时，直接以 body 为容器翻译全文
      if (node === document.body || node === document.documentElement || node === document) {
        return document.body;
      }
      let best = null, bestLen = 0;
      while (node && node !== document.body && node.nodeType === 1) {
        const len = (node.innerText || '').length;
        if (len > bestLen && len >= 300) { bestLen = len; best = node; }
        node = node.parentElement;
      }
      if (best) return best;
    }
    // 兜底：body 下文本最长的可见块
    const BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'DIV', 'TD', 'TH']);
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'ASIDE', 'HEADER', 'FOOTER', 'BUTTON', 'IFRAME', 'FORM', 'SVG']);
    const isOurUI = (n) => n && (n.id === SIDEBAR_ID || n.id === HOST_ID || n.id === FLOAT_ID);
    let best = null, bestLen = 0;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (isOurUI(n)) return NodeFilter.FILTER_REJECT;
        if (SKIP.has(n.tagName)) return NodeFilter.FILTER_REJECT;
        if (!BLOCK.has(n.tagName)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (w.nextNode()) {
      const el = w.currentNode;
      const len = (el.innerText || '').length;
      if (len > bestLen) { bestLen = len; best = el; }
    }
    return best || document.body;
  }

  // 收集容器内的可见文本块为段落（外层块优先，嵌套块去重，跳过中文段；可传入选区范围只收相交块）
  function collectSegments(container, range) {
    const segs = [];
    const collected = [];
    const BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'TD', 'TH', 'FIGCAPTION']);
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'ASIDE', 'BUTTON', 'AUDIO', 'VIDEO', 'IFRAME', 'FORM', 'SVG']);

    if (!container || container.nodeType !== 1) return segs;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.id === SIDEBAR_ID || node.id === HOST_ID || node.id === FLOAT_ID) return NodeFilter.FILTER_REJECT;
        if (SKIP.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        if (!BLOCK.has(node.tagName)) return NodeFilter.FILTER_SKIP;
        for (const c of collected) {
          if (c !== node && c.contains(node)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) {
      if (segs.length >= MAX_SEGS) break;
      const el = walker.currentNode;
      if (range && !range.intersectsNode(el)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      if (!el.getClientRects().length) continue;
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length < 2) continue;
      if (isMostlyChinese(text)) continue;
      segs.push({ el, text });
      collected.push(el);
    }

    // 兜底：一个段落都没有时（全是无标签文本），按句子把容器文本切成段
    if (!segs.length && container.innerText && container.innerText.trim().length > 2) {
      const full = (range ? range.toString() : container.innerText).replace(/\s+/g, ' ').trim();
      if (!isMostlyChinese(full)) {
        const parts = full.split(/(?<=[.!?])\s+/);
        let buf = '';
        let seq = 0;
        for (const part of parts) {
          buf += (buf ? ' ' : '') + part;
          if (buf.length >= 400 || (part && /[.!?]$/.test(part) && buf.length >= 120)) {
            segs.push({ el: container, text: buf });
            collected.push(container);
            buf = '';
            seq++;
            if (segs.length >= MAX_SEGS) break;
          }
        }
        if (buf && segs.length < MAX_SEGS) segs.push({ el: container, text: buf });
      }
    }
    return segs;
  }

  // ---------- 侧窗 UI ----------
  function openSidebar(segs) {
    destroySidebar();
    const el = document.createElement('div');
    el.id = SIDEBAR_ID;
    // user-select:none：cmd+A 全选时不会把侧窗译文一起选上（shadow 内继承此属性）
    el.style.cssText = 'all:initial;position:fixed;top:0;right:0;bottom:0;z-index:2147483646;-webkit-user-select:none;user-select:none;pointer-events:none;';
    const shadow = el.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        /* 面板与悬浮球是同一个元素：展开=右侧全高面板，收起=.ball 收缩成圆球，形态连续过渡 */
        .panel {
          position: absolute; top: 0; right: 0;
          height: 100%;
          width: var(--sbw, min(560px, 42vw));
          background: #fff;
          border-left: 1px solid rgba(0,0,0,.08);
          box-shadow: -8px 0 28px rgba(0,0,0,.08);
          border-radius: 0;
          overflow: hidden;
          display: flex; flex-direction: column;
          pointer-events: auto;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
          transform: translateX(100%);
          transition:
            width .34s cubic-bezier(.16,1,.3,1),
            height .34s cubic-bezier(.16,1,.3,1),
            top .34s cubic-bezier(.16,1,.3,1),
            right .34s cubic-bezier(.16,1,.3,1),
            border-radius .34s cubic-bezier(.16,1,.3,1),
            border-color .2s ease,
            box-shadow .3s ease,
            transform .28s cubic-bezier(.16,1,.3,1);
        }
        .panel.show { transform: translateX(0); }
        /* 收起态：面板向右侧中央聚拢，连续变形为 54px 圆球（即悬浮球） */
        .panel.ball {
          top: calc(50% - 27px); right: 22px;
          width: 54px !important; height: 54px;
          border-radius: 50%;
          border-left-color: transparent;
          box-shadow: 0 2px 8px rgba(0,0,0,.10), 0 12px 32px rgba(0,0,0,.18);
          cursor: pointer;
        }
        .panel.ball:hover {
          box-shadow: 0 2px 10px rgba(0,0,0,.12), 0 14px 38px rgba(0,0,0,.24);
        }
        /* 收球时面板内容淡出，展开时淡入 */
        .head, .cols, .resizer { transition: opacity .18s ease; }
        .panel.ball .head, .panel.ball .cols, .panel.ball .resizer {
          opacity: 0; pointer-events: none;
        }
        /* 球面上的"译"字，只在球态显现 */
        .ball-label {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          color: #10a37f; font-weight: 700; font-size: 18px;
          opacity: 0; transform: scale(.5); pointer-events: none;
          transition: opacity .2s ease .12s, transform .32s cubic-bezier(.16,1,.3,1) .12s;
        }
        .panel.ball .ball-label { opacity: 1; transform: scale(1); }
        .resizer {
          position: absolute; left: -3px; top: 0; bottom: 0;
          width: 7px; cursor: col-resize; z-index: 3;
          transition: background .15s ease;
        }
        .resizer::after {
          content: ''; position: absolute; left: 2px; top: 0; bottom: 0;
          width: 2px; background: transparent; transition: background .15s ease;
        }
        .panel.show .resizer:hover::after, .resizing .resizer::after {
          background: #10a37f;
        }
        .head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 14px 18px;
          border-bottom: 1px solid #f0f0f2;
          flex: 0 0 auto;
        }
        .title { font-size: 15px; font-weight: 700; color: #0d0d0d; }
        .badge {
          margin-left: 8px; padding: 2px 8px; border-radius: 999px;
          background: #f0fdf9; color: #0b6e57;
          font-size: 11px; font-weight: 600;
          border: 1px solid #ccf5e4;
        }
        .head-right { display: flex; align-items: center; gap: 10px; }
        .status { font-size: 12px; color: #6b7280; }
        .close {
          border: none; background: transparent; color: #6b7280;
          font-size: 12px; font-weight: 500; cursor: pointer;
          padding: 4px 8px; line-height: 1.4;
          border-radius: 6px; font-family: inherit;
          transition: color .12s ease, background .12s ease;
        }
        .close:hover { color: #0d0d0d; background: rgba(0,0,0,.05); }
        .cols { flex: 1 1 auto; overflow-y: auto; }
        .row {
          padding: 12px 18px;
          border-bottom: 1px solid #f4f4f5;
          cursor: pointer;
          transition: background .12s ease;
        }
        .row:hover { background: #f7f7f8; }
        .row.fail { background: #fffafa; box-shadow: inset 3px 0 0 #f0c2c2; }
        .row.hi { background: #f0fdf9; box-shadow: inset 3px 0 0 #10a37f; }
        .trans {
          font-size: 14px; line-height: 1.7;
          color: #0d0d0d;
          white-space: pre-wrap; word-break: break-word;
        }
        .ph { color: #a1a1aa; font-size: 13px; }
        .ph-err { color: #a15c5c; font-size: 13px; line-height: 1.6; }
        .skel { display: flex; flex-direction: column; gap: 8px; padding: 6px 0 2px; }
        .skel span {
          display: block; height: 10px; border-radius: 999px; background: #eeeef1;
        }
        .skel span:last-child { width: 68%; }
        .retry {
          display: inline-flex; align-items: center;
          margin-top: 10px;
          border: 1px solid #d4d4d8; border-radius: 8px;
          background: #fff; color: #0d0d0d;
          font-size: 13px; font-weight: 500;
          padding: 7px 14px; cursor: pointer;
          font-family: inherit;
          transition: background .12s ease, border-color .12s ease;
        }
        .retry:hover { background: #f4f4f5; border-color: #a1a1aa; }
      </style>
      <div class="panel">
        <div class="resizer" data-role="resizer" title="拖拽调整宽度（最多到页面一半）"></div>
        <div class="head">
          <div style="display:flex;align-items:center;">
            <span class="title">全文翻译</span>
            <span class="badge">DeepSeek</span>
          </div>
          <div class="head-right">
            <span class="status" data-role="status">准备中…</span>
            <button class="close" title="收起">收起</button>
          </div>
        </div>
        <div class="cols" data-role="cols"></div>
        <div class="ball-label">译</div>
      </div>
    `;
    document.body.appendChild(el);
    sidebarHost = el; // 记录宿主，收起/销毁/点空白判断都依赖它

    const panel = shadow.querySelector('.panel');
    const cols = shadow.querySelector('[data-role="cols"]');
    const statusEl = shadow.querySelector('[data-role="status"]');
    const indexMap = new Map();
    const rows = [];

    segs.forEach((seg, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.idx = String(i);
      const trans = document.createElement('div');
      trans.className = 'trans';
      showSkeleton(trans);
      row.appendChild(trans);
      cols.appendChild(row);
      indexMap.set(seg.el, i);
      rows.push(row);
    });

    const resizer = shadow.querySelector('[data-role="resizer"]');
    resizer.addEventListener('mousedown', onResizeDown);

    shadow.querySelector('.close').addEventListener('click', (e) => {
      // 必须阻止冒泡：否则同一次点击继续冒泡到 .panel，会被下面“球态点击即展开”误判，导致收不起
      e.stopPropagation();
      softCloseSidebar();
    });
    shadow.querySelector('.panel').addEventListener('click', (e) => {
      // 球形态下点击任意位置 = 展开恢复
      if (sidebarState && sidebarState.soft) { restoreSidebar(); return; }
      const row = e.target.closest('.row');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      const seg = segs[idx];
      if (!seg) return;
      setActiveRow(idx);
      highlightOrig(seg, true);
    });
    shadow.querySelector('.panel').addEventListener('mouseover', (e) => {
      const row = e.target.closest('.row');
      if (!row) return;
      setActiveRow(Number(row.dataset.idx), false);
    });

    sidebarState = {
      segs, indexMap, rows, cols, statusEl, panel,
      session: {},
      reqGen: segs.map(() => 0),
      outcomes: segs.map(() => 'pending')
    };
    sidebarState.soft = false;

    requestAnimationFrame(() => panel.classList.add('show'));

    // 原文侧事件委托：hover 只高亮，click 才滚动定位
    const container = segs.length ? (segs[0].el.parentElement || document.body) : document.body;
    container.addEventListener('mouseover', onOrigOver, true);
    container.addEventListener('click', onOrigClick, true);
    sidebarState.container = container;
    ensureHiStyle();
  }

  // 已收起时恢复侧窗（数据仍在 DOM 里，无需重新翻译）
  // 展开：球形态连续变形回面板（数据仍在 DOM 里，无需重新翻译）
  function restoreSidebar() {
    if (!sidebarHost || !sidebarState) return;
    const panel = sidebarHost.shadowRoot.querySelector('.panel');
    if (!panel) return;
    panel.classList.remove('ball');
    panel.title = '';
    sidebarState.soft = false;
  }

  // 收起：面板连续收缩、聚拢成右侧中央的圆球（即悬浮球），翻译结果保留
  function softCloseSidebar() {
    if (!sidebarHost || !sidebarState || sidebarState.soft) return;
    const panel = sidebarHost.shadowRoot.querySelector('.panel');
    if (!panel) return;
    sidebarState.soft = true;
    panel.classList.add('ball');
    panel.title = '恢复全文翻译侧窗';
  }

  // 彻底销毁（重新翻译前调用）
  function destroySidebar() {
    if (sidebarState && sidebarState.container) {
      sidebarState.container.removeEventListener('mouseover', onOrigOver, true);
      sidebarState.container.removeEventListener('click', onOrigClick, true);
    }
    // 兜底：按 ID 全量移除残留宿主（getElementById 只取第一个，可能有多个残留）
    document.querySelectorAll('#' + SIDEBAR_ID).forEach((n) => n.remove());
    if (sidebarHost) {
      sidebarHost.remove();
      sidebarHost = null;
    }
    sidebarState = null;
    if (hiStyleEl) { hiStyleEl.remove(); hiStyleEl = null; }
    document.querySelectorAll('.' + HL_CLASS).forEach((el) => el.classList.remove(HL_CLASS));
    // 清理旧版本可能残留的独立悬浮球宿主（新版悬浮球即面板球形态，无独立宿主）
    document.querySelectorAll('#' + FLOAT_ID).forEach((n) => n.remove());
  }

  // ---------- 拖拽调宽 ----------
  function onResizeDown(e) {
    if (!sidebarState || !sidebarState.panel) return;
    e.preventDefault();
    e.stopPropagation();
    const panel = sidebarState.panel;
    dragState = { startX: e.clientX, startW: panel.getBoundingClientRect().width };
    panel.classList.add('resizing');
    document.addEventListener('mousemove', onResizeMove);
    document.addEventListener('mouseup', onResizeUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function onResizeMove(e) {
    if (!dragState || !sidebarState || !sidebarState.panel) return;
    const vw = window.innerWidth;
    const w = dragState.startW + (dragState.startX - e.clientX);
    sidebarState.panel.style.setProperty('--sbw', Math.max(SBAR_MIN_W, Math.min(w, vw * SBAR_MAX_RATIO)) + 'px');
  }

  function onResizeUp() {
    if (sidebarState && sidebarState.panel) sidebarState.panel.classList.remove('resizing');
    dragState = null;
    document.removeEventListener('mousemove', onResizeMove);
    document.removeEventListener('mouseup', onResizeUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  // 点击页面空白处收起侧窗（点击原文段落走 onOrigClick 联动，不收起）
  function onDocClick(e) {
    if (!sidebarHost) return;
    // 已是球形态就不再响应空白点击
    if (sidebarState && sidebarState.soft) return;
    let t = e.target;
    if (t && t.nodeType === Node.TEXT_NODE) t = t.parentElement;
    if (sidebarState && sidebarState.indexMap.has(t)) return; // 点原文段 → 联动
    if (e.composedPath().includes(sidebarHost)) return;
    softCloseSidebar();
  }

  function onOrigOver(e) {
    if (!sidebarState) return;
    let t = e.target;
    if (t && t.nodeType === Node.TEXT_NODE) t = t.parentElement;
    const idx = sidebarState.indexMap.get(t);
    if (idx === undefined) return;
    setActiveRow(idx, false);
  }

  function onOrigClick(e) {
    if (!sidebarState) return;
    let t = e.target;
    if (t && t.nodeType === Node.TEXT_NODE) t = t.parentElement;
    const idx = sidebarState.indexMap.get(t);
    if (idx === undefined) return;
    e.stopPropagation();
    setActiveRow(idx, true);
    // 原文自身高亮 + 滚动到侧窗对应行
    scrollSidebarTo(idx);
  }

  function setActiveRow(idx, scroll) {
    if (!sidebarState) return;
    sidebarState.rows.forEach((r, i) => r.classList.toggle('hi', i === idx));
    if (scroll) scrollSidebarTo(idx);
  }

  function scrollSidebarTo(idx) {
    if (!sidebarState) return;
    const row = sidebarState.rows[idx];
    if (!row) return;
    const cols = sidebarState.cols;
    const target = row.offsetTop - cols.clientHeight / 2 + row.clientHeight / 2;
    cols.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }

  function ensureHiStyle() {
    if (hiStyleEl) return;
    hiStyleEl = document.createElement('style');
    hiStyleEl.textContent = `.${HL_CLASS}{background:rgba(16,163,127,.16)!important;border-radius:3px;transition:background .15s ease;}`;
    (document.head || document.documentElement).appendChild(hiStyleEl);
  }

  function clearOrigHighlights() {
    if (!sidebarState) return;
    sidebarState.segs.forEach((seg) => seg.el.classList.remove(HL_CLASS));
  }

  function highlightOrig(seg, scroll) {
    if (!sidebarState) return;
    clearOrigHighlights();
    seg.el.classList.add(HL_CLASS);
    if (scroll) {
      try { seg.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { /* noop */ }
    }
  }

  function showSkeleton(trans) {
    trans.replaceChildren();
    const skel = document.createElement('div');
    skel.className = 'skel';
    skel.appendChild(document.createElement('span'));
    skel.appendChild(document.createElement('span'));
    trans.appendChild(skel);
  }

  function updateTransCell(idx, text, isErr) {
    if (!sidebarState || !sidebarState.rows[idx]) return;
    const row = sidebarState.rows[idx];
    const trans = row.querySelector('.trans');
    if (!trans) return;
    row.classList.toggle('fail', !!isErr);
    trans.replaceChildren();
    if (!isErr) {
      trans.textContent = text;
      return;
    }
    const err = document.createElement('div');
    err.className = 'ph-err';
    err.textContent = FAIL_HINT;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'retry';
    btn.textContent = '重新翻译';
    if (text) btn.title = text;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      retrySegment(idx);
    });
    trans.appendChild(err);
    trans.appendChild(btn);
  }

  function setOutcome(idx, state) {
    if (!sidebarState || !sidebarState.outcomes) return;
    sidebarState.outcomes[idx] = state;
    const outcomes = sidebarState.outcomes;
    const total = outcomes.length;
    const pending = outcomes.filter((s) => s === 'pending').length;
    const failed = outcomes.filter((s) => s === 'fail').length;
    const retrying = outcomes.filter((s) => s === 'retry').length;
    if (pending) {
      updateStatus('翻译中 ' + (total - pending) + '/' + total + '…');
      return;
    }
    const shown = failed + retrying;
    updateStatus(shown ? ('完成，' + shown + ' 段失败') : '翻译完成');
  }

  function updateStatus(text) {
    if (sidebarState && sidebarState.statusEl) sidebarState.statusEl.textContent = text;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------- 全文翻译流程 ----------
  // forceFull=true：toast「翻译全文」入口，无视当前选区，抓整篇文章容器
  // forceFull=false：划长段 / cmd+A 入口，按选区范围收集
  function fullTranslateFromSelection(forceFull) {
    const sel = window.getSelection();
    const range = (sel && sel.rangeCount) ? sel.getRangeAt(0).cloneRange() : lastRange;
    if (!range && !forceFull) {
      showToastMessage('未找到可翻译的内容，请先选中一段文字');
      return;
    }
    let container;
    if (forceFull) {
      // 全文模式：优先 article/main 语义主区域；没有就用 body（兼容段落平铺在 body 下的页面）
      container = document.querySelector('article, main, [role="main"]') || document.body;
    } else {
      container = findContainer(range);
    }
    const segs = collectSegments(container, forceFull ? null : range);
    if (!segs.length) {
      showToastMessage('未找到可翻译的英文段落');
      return;
    }
    close();
    openSidebar(segs);
    runBatchTranslate(segs);
  }

  function applySegmentResult(session, idx, gen, ok, text) {
    if (!sidebarState || sidebarState.session !== session) return;
    if (sidebarState.reqGen[idx] !== gen) return;
    if (ok) {
      updateTransCell(idx, text, false);
      setOutcome(idx, 'ok');
    } else {
      updateTransCell(idx, text, true);
      setOutcome(idx, 'fail');
    }
  }

  function runBatchTranslate(segs) {
    const session = sidebarState && sidebarState.session;
    const total = segs.length;
    updateStatus('翻译中 0/' + total + '…');

    (async () => {
      for (let i = 0; i < total; i += BATCH_SIZE) {
        if (!sidebarState || sidebarState.session !== session) return;
        const batch = segs.slice(i, i + BATCH_SIZE).map((s, k) => ({ id: i + k, text: s.text }));
        const gens = batch.map((b) => sidebarState.reqGen[b.id]);
        const resp = await sendMsg({ type: 'translate_batch', segments: batch });
        if (!sidebarState || sidebarState.session !== session) return;
        if (resp && resp.ok && Array.isArray(resp.results)) {
          resp.results.forEach((r) => {
            if (!r) return;
            const pos = batch.findIndex((b) => b.id === r.id);
            if (pos < 0) return;
            if (r.ok) applySegmentResult(session, r.id, gens[pos], true, r.text);
            else applySegmentResult(session, r.id, gens[pos], false, (r.error ? '翻译失败：' + r.error : '翻译失败'));
          });
        } else {
          const msg = (resp && resp.error) ? resp.error : '批量翻译失败';
          batch.forEach((b, k) => applySegmentResult(session, b.id, gens[k], false, '翻译失败：' + msg));
        }
      }
    })();
  }

  // 只重译失败的那一段，不重跑整篇
  async function retrySegment(idx) {
    if (!sidebarState || !sidebarState.segs[idx]) return;
    const session = sidebarState.session;
    const seg = sidebarState.segs[idx];
    const gen = ++sidebarState.reqGen[idx];
    setOutcome(idx, 'retry');
    const row = sidebarState.rows[idx];
    const trans = row && row.querySelector('.trans');
    if (row) row.classList.remove('fail');
    if (trans) {
      trans.replaceChildren();
      const pending = document.createElement('div');
      pending.className = 'ph';
      pending.textContent = '重新翻译中…';
      trans.appendChild(pending);
    }

    const resp = await sendMsg({ type: 'translate_batch', segments: [{ id: idx, text: seg.text }] });
    if (!sidebarState || sidebarState.session !== session || sidebarState.reqGen[idx] !== gen) return;

    let result = null;
    if (resp && resp.ok && Array.isArray(resp.results)) {
      result = resp.results.find((r) => r && r.id === idx) || resp.results[0];
    }
    if (result && result.ok) {
      applySegmentResult(session, idx, gen, true, result.text);
    } else {
      const msg = (result && result.error) || (resp && resp.error) || '重新翻译失败';
      applySegmentResult(session, idx, gen, false, '翻译失败：' + msg);
    }
  }

  // 兜底提示（用 toast 的样式）
  function showToastMessage(text) {
    close();
    host = buildHost();
    document.body.appendChild(host);
    const card = host.shadowRoot.querySelector('.card');
    const body = host.shadowRoot.querySelector('.body');
    const p = document.createElement('div');
    p.textContent = text;
    body.appendChild(p);
    card.style.left = '50%';
    card.style.top = '30%';
    card.style.transform = 'translateX(-50%)';
    card.classList.add('show');
    host.shadowRoot.querySelector('.close').addEventListener('click', close);
  }

  // ---------- 事件 ----------
  function onMouseUp(e) {
    if (!config.enabled) return;
    // 拖拽调宽进行中的 mouseup（可能松手在侧窗外），不触发翻译
    if (dragState) return;
    // 点击（非拖选）不触发翻译：cmd+A 全选后选区会残留，点击页面会被误判为“划了全文”。
    // 没有真实 mousedown 的合成/辅助点击也视为点击。
    const hadDown = hasMouseDown;
    hasMouseDown = false;
    if (!hadDown || (Math.abs(e.clientX - mouseDownX) < 4 && Math.abs(e.clientY - mouseDownY) < 4)) return;
    // 点击发生在 toast / 侧窗内部时，由内部逻辑处理
    if (host && e.composedPath().includes(host)) return;
    if (sidebarHost && e.composedPath().includes(sidebarHost)) return;

    const raw = getRawSelectedText();
    if (!raw) return;
    if (isMostlyChinese(raw)) return;

    // 立即缓存选区位置与范围（有些页面会在 mouseup 后清空选区）
    const sel = window.getSelection();
    lastRange = (sel && sel.rangeCount) ? sel.getRangeAt(0).cloneRange() : null;
    const rect = getSelectionRect();
    if (!rect) return;

    clearTimeout(timer);
    if (raw.length > MAX_LEN) {
      // 长文 / 全文模式：进侧窗
      timer = setTimeout(fullTranslateFromSelection, DEBOUNCE_MS);
    } else {
      const text = raw.replace(/\s+/g, ' ').trim();
      timer = setTimeout(() => showAt(rect, text), DEBOUNCE_MS);
    }
  }

  function onMouseDown(e) {
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    hasMouseDown = true;
    if (!host) return;
    if (!e.composedPath().includes(host)) close();
  }

  // Cmd/Ctrl + A 全选：键盘操作不产生 mouseup，单独监听 keyup 触发全文翻译
  function onKeyUp(e) {
    if (!config.enabled) return;
    if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a')) return;
    if (host && e.composedPath().includes(host)) return;
    if (sidebarHost && e.composedPath().includes(sidebarHost)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const raw = getRawSelectedText();
      if (!raw || isMostlyChinese(raw)) return;
      const sel = window.getSelection();
      lastRange = (sel && sel.rangeCount) ? sel.getRangeAt(0).cloneRange() : null;
      fullTranslateFromSelection();
    }, 250);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      close();
      softCloseSidebar();
    }
  }

  // 滚动 / 缩放：toast 不消失，跟随选区重新定位；选区丢失则钉在视口内
  function onViewportChange() {
    if (!host) return;
    const card = host.shadowRoot.querySelector('.card');
    if (!card) return;
    const rect = getSelectionRect();
    if (rect) {
      positionCard(card, rect);
    } else {
      const r = card.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      card.style.left = Math.max(8, Math.min(r.left, vw - r.width - 8)) + 'px';
      card.style.top = Math.max(8, Math.min(r.top, vh - r.height - 8)) + 'px';
    }
  }

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  window.addEventListener('resize', onViewportChange);

  loadConfig();
})();
