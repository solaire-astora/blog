/**
 * 放大浏览（lightbox）
 *
 * 挂在正文里的图片与 SVG 图表上：点击放大到遮罩层，Esc 或点空白关闭，
 * 左右箭头在同一篇文章的图之间切换。
 *
 * 三条设计约束：
 *   1. 无 JS 时必须仍可用 —— 位图外层保留 <a href="原图">，脚本只是拦住
 *      点击改为开 lightbox；脚本没跑起来时点击照旧新标签页打开原图。
 *   2. 键盘可完成全部操作，且关闭后焦点回到原位（不把用户扔回页首）。
 *   3. 不引入依赖、不改变正文 DOM 结构 —— 遮罩层是运行时建的。
 *
 * 位图放大后显示原始像素（火焰图原图 2048px，正文里只有 680px）；
 * SVG 是矢量，放大后按视口等比撑开。
 */
export const lightboxScript = `
(function () {
  var items = [];
  document.querySelectorAll('.prose .imgLink, .prose .diagram').forEach(function (el) {
    var isDiagram = el.classList.contains('diagram');
    var media = isDiagram ? el.querySelector('svg') : el.querySelector('img');
    if (!media) return;
    var cap = el.querySelector('figcaption');
    items.push({
      trigger: el,
      isDiagram: isDiagram,
      src: isDiagram ? null : media.getAttribute('src'),
      alt: isDiagram ? '' : media.getAttribute('alt') || '',
      svg: isDiagram ? media : null,
      caption: cap ? cap.textContent.trim() : (isDiagram ? '' : media.getAttribute('alt') || ''),
    });
  });
  if (!items.length) return;

  // 标记脚本已挂载：CSS 据此才给出 zoom-in 光标，避免无 JS 时误导
  document.documentElement.classList.add('lb-ready');

  var box = null, stage = null, capEl = null, idxEl = null, current = -1, lastFocus = null;

  function build() {
    box = document.createElement('div');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '图片放大浏览');
    box.innerHTML =
      '<button class="lbClose" type="button" aria-label="关闭"><span aria-hidden="true">&times;</span></button>' +
      '<button class="lbNav lbPrev" type="button" aria-label="上一张"><span aria-hidden="true">&#8592;</span></button>' +
      '<button class="lbNav lbNext" type="button" aria-label="下一张"><span aria-hidden="true">&#8594;</span></button>' +
      '<div class="lbStage"></div>' +
      '<div class="lbBar"><span class="cap lbCap"></span><span class="cap lbIdx"></span></div>';
    document.body.appendChild(box);
    stage = box.querySelector('.lbStage');
    capEl = box.querySelector('.lbCap');
    idxEl = box.querySelector('.lbIdx');

    box.querySelector('.lbClose').addEventListener('click', close);
    box.querySelector('.lbPrev').addEventListener('click', function (e) { e.stopPropagation(); go(-1); });
    box.querySelector('.lbNext').addEventListener('click', function (e) { e.stopPropagation(); go(1); });
    // 点遮罩空白处关闭，但点在图上不关
    box.addEventListener('click', function (e) {
      if (e.target === box || e.target === stage) close();
    });
  }

  function show(i) {
    var it = items[i];
    if (!it) return;
    current = i;
    stage.textContent = '';

    if (it.isDiagram) {
      // SVG 克隆一份进遮罩层。原图的 id 在克隆后会重复，故加前缀避免
      // aria-labelledby 与 marker 指向错误的定义。
      var clone = it.svg.cloneNode(true);
      clone.removeAttribute('aria-labelledby');
      clone.setAttribute('aria-label', it.caption || '图表');
      clone.querySelectorAll('[id]').forEach(function (n) {
        var old = n.getAttribute('id');
        n.setAttribute('id', 'lb-' + old);
      });
      clone.innerHTML = clone.innerHTML.replace(/url\\(#([^)]+)\\)/g, 'url(#lb-$1)');
      clone.classList.add('lbSvg');
      stage.appendChild(clone);
    } else {
      var img = document.createElement('img');
      img.src = it.src;
      img.alt = it.alt;
      img.className = 'lbImg';
      stage.appendChild(img);
    }

    capEl.textContent = it.caption;
    idxEl.textContent = items.length > 1 ? (i + 1) + ' / ' + items.length : '';
    box.querySelector('.lbPrev').hidden = items.length < 2;
    box.querySelector('.lbNext').hidden = items.length < 2;
  }

  function open(i) {
    if (!box) build();
    lastFocus = document.activeElement;
    show(i);
    box.classList.add('on');
    document.documentElement.classList.add('lb-open');
    box.querySelector('.lbClose').focus();
    document.addEventListener('keydown', onKey);
  }

  function close() {
    if (!box) return;
    box.classList.remove('on');
    document.documentElement.classList.remove('lb-open');
    document.removeEventListener('keydown', onKey);
    stage.textContent = '';
    // 焦点回到点开它的那张图，键盘用户不会被扔回页首
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    current = -1;
  }

  function go(step) {
    if (current < 0) return;
    show((current + step + items.length) % items.length);
  }

  function onKey(e) {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowLeft') { go(-1); return; }
    if (e.key === 'ArrowRight') { go(1); return; }
    // 焦点锁在遮罩层内，Tab 不会跑到背后的页面上
    if (e.key === 'Tab') {
      var f = [].slice.call(box.querySelectorAll('button')).filter(function (b) { return !b.hidden; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  items.forEach(function (it, i) {
    // 位图外层是 <a href="原图">：拦住点击改为开 lightbox。
    // 按住 Cmd/Ctrl/Shift 或中键时不拦，保留"在新标签页打开"的习惯。
    it.trigger.addEventListener('click', function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      open(i);
    });
    // SVG 图表外层是 <figure>，本身不可聚焦，补上键盘入口
    if (it.isDiagram) {
      it.trigger.setAttribute('tabindex', '0');
      it.trigger.setAttribute('role', 'button');
      it.trigger.setAttribute('aria-label', (it.caption || '图表') + '（放大查看）');
      it.trigger.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(i); }
      });
    }
  });
})();
`;
