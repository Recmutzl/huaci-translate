// 划词翻译 options.js —— 设置页逻辑
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const testResultEl = $('testResult');

  function currentEngine() {
    const el = document.querySelector('input[name="engine"]:checked');
    return el ? el.value : 'baidu';
  }

  function setStatus(msg, ok) {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + (ok ? 'ok' : 'err');
  }

  function showTestResult(text, ok) {
    testResultEl.style.display = 'block';
    testResultEl.textContent = text;
    testResultEl.className = 'test-result ' + (ok ? 'ok' : 'err');
  }

  // 引擎切换时显示对应 Key 输入区
  function syncEngineUI() {
    const engine = currentEngine();
    $('baidu-row').style.display = engine === 'baidu' ? '' : 'none';
    $('deepseek-row').style.display = engine === 'deepseek' ? '' : 'none';
  }

  // 读取现有配置填入表单
  function load() {
    chrome.storage.local.get({
      enabled: true,
      auto: true,
      engine: 'baidu',
      baiduAppid: '',
      baiduKey: '',
      deepseekKey: ''
    }, (items) => {
      $('enabled').checked = !!items.enabled;
      $('auto').checked = !!items.auto;
      const engine = items.engine === 'deepseek' ? 'deepseek' : 'baidu';
      const radio = document.querySelector('input[name="engine"][value="' + engine + '"]');
      if (radio) radio.checked = true;
      $('baiduAppid').value = items.baiduAppid || '';
      $('baiduKey').value = items.baiduKey || '';
      $('deepseekKey').value = items.deepseekKey || '';
      syncEngineUI();
    });
  }

  function collect() {
    return {
      enabled: $('enabled').checked,
      auto: $('auto').checked,
      engine: currentEngine(),
      baiduAppid: $('baiduAppid').value.trim(),
      baiduKey: $('baiduKey').value.trim(),
      deepseekKey: $('deepseekKey').value.trim()
    };
  }

  // 保存
  function save() {
    chrome.storage.local.set(collect(), () => {
      setStatus('已保存 ✓', true);
      testResultEl.style.display = 'none';
    });
  }

  // 测试：用当前表单里的配置直接发一次翻译请求
  function test() {
    const data = collect();
    // 先保存，保证后台读到最新配置
    chrome.storage.local.set(data, () => {
      setStatus('测试中…', true);
      showTestResult('请求翻译引擎中，请稍候…', true);
      chrome.runtime.sendMessage({
        type: 'translate',
        text: 'Hello world, this is a quick test of the translation plugin.',
        engine: data.engine
      }, (resp) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          setStatus('测试失败', false);
          showTestResult('扩展出错：' + lastErr.message, false);
          return;
        }
        if (resp && resp.ok) {
          setStatus('测试成功 ✓', true);
          showTestResult('译文：\n' + resp.text + '\n（引擎：' + (resp.engine === 'deepseek' ? 'DeepSeek' : '百度') + '）', true);
        } else {
          setStatus('测试失败', false);
          showTestResult('翻译失败：' + ((resp && resp.error) ? resp.error : '未知错误，请检查设置') + '\n\n常见原因：\n· 百度：APP ID / 密钥填错，或 IP 未加入白名单\n· DeepSeek：API Key 无效或余额不足', false);
        }
      });
    });
  }

  document.querySelectorAll('input[name="engine"]').forEach((r) => {
    r.addEventListener('change', syncEngineUI);
  });
  $('saveBtn').addEventListener('click', save);
  $('testBtn').addEventListener('click', test);

  load();
})();
