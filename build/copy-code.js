/**
 * 代码块的外层容器与复制按钮
 *
 * 做两件事：
 *   1. 给每个 pre 套一层不滚动的 .codeBlock，并把语言标记从 pre 内提到该层。
 *      这是布局的必要条件 —— pre 自身是横向滚动容器，标记 absolute 到它上面
 *      时定位基准是含溢出部分的内容盒，横滚时会跟着代码滑走（cpo 那篇溢出
 *      206px，标记直接滚出可视区）。sticky 也不成：float 到右边缘后没有可
 *      粘附的偏移空间。
 *   2. 在该层右上角加复制按钮。
 *
 * 三条设计约束：
 *   1. 按钮由 JS 注入 —— 无 JS 时它不存在。渲染一个点了没反应的按钮
 *      比没有按钮更糟。语言标记则在无 JS 时留在 pre 内，CSS 有对应兜底。
 *   2. 复制的是代码原文，不含语言标记 —— 标记与 code 是兄弟节点，
 *      取容器的 textContent 会把 "CPP" 一起复制进去。
 *   3. navigator.clipboard 要求安全上下文（https 或 localhost），本地
 *      http:// 预览下不可用，回落到 execCommand；两者都失败则告知用户
 *      而不是静默假装成功。
 */
export const copyCodeScript = `
(function () {
  var pres = document.querySelectorAll('.prose pre');
  if (!pres.length) return;

  var ICON_COPY =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
    '<path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';
  var ICON_DONE =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M4 12.5l5 5L20 6.5"/></svg>';

  function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // 回落：临时 textarea + execCommand。已废弃但在 http:// 下仍是唯一选择
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      // 记住原选区，复制后还原 —— 不要打断用户已选中的文本
      var sel = document.getSelection();
      var saved = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {}
      document.body.removeChild(ta);
      if (saved) {
        sel.removeAllRanges();
        sel.addRange(saved);
      }
      ok ? resolve() : reject(new Error('execCommand 失败'));
    });
  }

  [].forEach.call(pres, function (pre) {
    var code = pre.querySelector('code');
    if (!code) return;

    // 套外层容器（渲染时不做，见文件头说明）
    var host = document.createElement('div');
    host.className = 'codeBlock';
    pre.parentNode.insertBefore(host, pre);
    host.appendChild(pre);

    // 语言标记提到外层 —— 留在 pre 内会随横向滚动滑走
    var lang = pre.querySelector('.code-lang');
    if (lang) {
      host.insertBefore(lang, pre);
      host.classList.add('hasCopy');
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copyBtn';
    btn.innerHTML = ICON_COPY;
    btn.setAttribute('aria-label', '复制代码');
    btn.title = '复制代码';
    host.appendChild(btn);

    var timer = null;
    btn.addEventListener('click', function () {
      // 取 code 而非 host —— 后者的 textContent 含语言标记
      writeClipboard(code.textContent).then(
        function () {
          btn.innerHTML = ICON_DONE;
          btn.classList.add('done');
          btn.setAttribute('aria-label', '已复制');
          btn.title = '已复制';
          clearTimeout(timer);
          timer = setTimeout(function () {
            btn.innerHTML = ICON_COPY;
            btn.classList.remove('done');
            btn.setAttribute('aria-label', '复制代码');
            btn.title = '复制代码';
          }, 2000);
        },
        function () {
          // 失败要说出来，否则用户以为复制成功了
          btn.title = '复制失败，请手动选择';
          btn.setAttribute('aria-label', '复制失败，请手动选择');
        },
      );
    });
  });
})();
`;
