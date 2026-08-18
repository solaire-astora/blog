/**
 * 模板层 —— 把内容代入设计程式，算出页面
 *
 * 这里没有模板引擎，只有返回字符串的函数。母题「环 + 刻针」被抽成 ring()
 * 一个函数，四个尺度（420px 首屏太阳 / 56px 年环 / 12px 条目环 / 40px 文章环）
 * 共用它，于是同一个角度在不同尺度上必然一致 —— 这是程式化设计的要求：
 * 版面上的每一处重复都由同一条规则算出，不靠人工对齐。
 */

import config from './config.js';
import { lightboxScript } from './lightbox.js';
import { copyCodeScript } from './copy-code.js';
import { helmSvg } from './helm.js';
import { bonfireSvg } from './bonfire.js';

/* ══════════════════════════════════════════════════════════════════
   基础工具
   ══════════════════════════════════════════════════════════════════ */

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAD = (n) => String(n).padStart(2, '0');

/** 2024-03-17 */
export const isoDate = (d) =>
  `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;

/** 2024.03.17 —— 索引与元信息里的展示形态，句点比连字符更接近刻度读数 */
export const dotDate = (d) =>
  `${d.getFullYear()}.${PAD(d.getMonth() + 1)}.${PAD(d.getDate())}`;

/** 03.17 —— 年份已由分组承担时，只需月日 */
export const shortDate = (d) => `${PAD(d.getMonth() + 1)}.${PAD(d.getDate())}`;

/* ══════════════════════════════════════════════════════════════════
   母题：环 + 刻针
   ══════════════════════════════════════════════════════════════════ */

/**
 * 一枚环。angles 里每个角度画一根 1px 刻针；sunAngle 命中的那根是橙色。
 *
 * @param {object} opts
 * @param {string} opts.size    尺度类名：r12 / r40 / r56
 * @param {number[]} opts.angles 要画的刻针角度
 * @param {number} [opts.sun]   橙色刻针的角度（当前太阳的位置）
 */
export function ring({ size, angles = [], sun = null }) {
  const hands = angles
    .map((a) => {
      const isSun = sun !== null && a === sun;
      return `<i class="${isSun ? 'sun' : ''}" style="transform:rotate(${a}deg)"></i>`;
    })
    .join('');
  return `<span class="ring ${size}" aria-hidden="true">${hands}</span>`;
}

/**
 * 420px 首屏太阳：外圈 12 个月刻度 + 全部文章落位 + 唯一一条橙射线。
 * 这是全站唯一一处「数据的整体形状」可见的地方 —— 19 篇文章在一年 12 个月上
 * 的分布本身就是图形，不需要另画插图。
 */
export function sunDial(posts, currentAngle) {
  const latest = posts[0];
  const firstYear = posts[posts.length - 1].date.getFullYear();
  const latestYear = latest.date.getFullYear();
  const yearCount = new Set(posts.map((p) => p.date.getFullYear())).size;

  const months = Array.from(
    { length: 12 },
    (_, i) => `<span class="m" style="transform:rotate(${i * 30}deg)"></span>`,
  ).join('');

  const entries = posts
    .filter((p) => p.angle !== currentAngle)
    .map((p) => `<span class="e" style="transform:rotate(${p.angle}deg)"></span>`)
    .join('');

  return `<div class="sundial">
      <div class="disc"></div><div class="disc2"></div><div class="disc3"></div>
      <div class="hands" aria-hidden="true">
        ${months}
        ${entries}
        <span class="ray" style="transform:rotate(${currentAngle}deg)"></span>
      </div>
      <div class="core">
        <span class="cap lbl top">writing since</span>
        <span class="num">${firstYear}</span>
        <span class="cap lbl">${firstYear}&mdash;${latestYear} &middot; ${yearCount} years stacked</span>
      </div>
      <p class="cap legend">one ring = one year &middot; 360&deg; = 12 months</p>
      <p class="cap anno">latest <span class="v">${String(currentAngle).padStart(3, '0')}&deg; &middot; ${dotDate(latest.date)}</span></p>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════════
   组件
   ══════════════════════════════════════════════════════════════════ */

const tagPill = (name) =>
  `<a class="tag" href="/tags/${encodeURIComponent(name)}/">${escapeHtml(name)}</a>`;

/**
 * 索引里的一行。一行一篇，无摘要无配图 —— 条目环 + 角度 + 标题 + 标签 + 日期。
 * 角度值补零三位，于是那一列自身对齐成一根刻度轴。
 */
function indexRow(post, currentAngle, { showYear = false } = {}) {
  const isLatest = post.angle === currentAngle;
  return `<li class="row${isLatest ? ' latest' : ''}">
      ${ring({ size: 'r12', angles: [post.angle], sun: isLatest ? post.angle : null })}
      <span class="deg">${post.deg}&deg;</span>
      <a class="t" href="${post.url}">${escapeHtml(post.title)}</a>
      <span class="tags">${post.tags.map(tagPill).join('')}</span>
      <time class="d" datetime="${isoDate(post.date)}">${showYear ? dotDate(post.date) : shortDate(post.date)}</time>
    </li>`;
}

/**
 * 按年分组的索引流。年份 + 年环构成粘性左轴。
 */
export function yearIndex(groups, currentAngle, { showYear = false } = {}) {
  return groups
    .map((g) => {
      const dates = g.angles.length;
      const meta =
        g.posts.length === 1
          ? '1 entry'
          : `${g.posts.length} entries &middot; ${dates} date${dates > 1 ? 's' : ''}`;
      return `<section class="yearblock">
      <div class="axis">
        <h2 class="y">${g.year}</h2>
        ${ring({ size: 'r56', angles: g.angles, sun: currentAngle })}
        <p class="cap meta">${meta}</p>
      </div>
      <ol class="rows">
        ${g.posts.map((p) => indexRow(p, currentAngle, { showYear })).join('\n')}
      </ol>
    </section>`;
    })
    .join('\n');
}

/** 章节标注：左标题 + hairline + 右注释 */
export function sectionLabel(left, right = '') {
  return `<div class="seclabel">
      <span class="t">${left}</span><span class="bar"></span>
      ${right ? `<span class="t">${right}</span>` : ''}
    </div>`;
}

/** 目录轴。层级从 h2 起（正文标题已下沉一级） */
function tocList(headings, maxLevel) {
  const items = headings.filter((h) => h.level <= maxLevel);
  if (items.length < 2) return ''; // 只有一个标题时目录没有意义

  return `<nav class="toc" aria-label="目录">
      <p class="cap h">contents</p>
      <ol>
        ${items
          .map(
            (h) =>
              `<li class="lv${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`,
          )
          .join('\n')}
      </ol>
    </nav>`;
}

/* ══════════════════════════════════════════════════════════════════
   页面骨架
   ══════════════════════════════════════════════════════════════════ */

/** 侧栏导航（骨架特征：220px 固定垂直侧栏，不用顶栏） */
function rail(activePath) {
  const items = config.menu
    .map(([href, en, zh]) => {
      const active =
        href === '/' ? activePath === '/' : activePath.startsWith(href);
      return `<a class="${active ? 'on' : ''}" href="${href}"${active ? ' aria-current="page"' : ''}>
          <span class="dot"></span>${en}<em>${zh}</em>
        </a>`;
    })
    .join('\n');

  return `<aside class="rail" id="rail">
      <button class="railToggle" type="button" aria-controls="rail" aria-expanded="true"
              title="收起导航">
        <span class="bars" aria-hidden="true"><i></i><i></i></span>
        <span class="srOnly">收起导航</span>
      </button>
      <div class="railTop">
        <a class="mark" href="/" aria-label="${escapeHtml(config.title)} 首页">
          ${helmSvg}
          <span class="markText">
            <span class="sitename">${escapeHtml(config.title)}</span>
            <span class="cap sitesub">${config.titleEn} / ${config.praiseEn}</span>
          </span>
        </a>
        <div class="railBody">
          <nav class="vnav" aria-label="主导航">${items}</nav>
        </div>
      </div>
      <div class="railFoot">
        <div class="bonfire" title="篝火">
          <div class="bonfireWin">${bonfireSvg}</div>
        </div>
        <p class="cap formula">angle = (m&minus;1)&times;30&deg;<br>+ (d/30)&times;30&deg;</p>
      </div>
    </aside>`;
}

function footer(currentAngle) {
  const thisYear = new Date().getFullYear();
  const span =
    thisYear > config.since ? `${config.since}–${thisYear}` : config.since;
  return `<footer>
      <p class="l">
        ${ring({ size: 'r12', angles: [currentAngle], sun: currentAngle })}
        <span class="cap">&copy; ${span} ${escapeHtml(config.author)} &middot; ${escapeHtml(config.title)}</span>
      </p>
      <p class="cap">${config.icp ? escapeHtml(config.icp) + ' &middot; ' : ''}${config.praiseEn}</p>
    </footer>`;
}

/**
 * 页面外壳。
 *
 * @param {object} opts
 * @param {string} opts.title       <title> 内容
 * @param {string} opts.description meta description
 * @param {string} opts.path        当前路径，用于导航当前态
 * @param {number} opts.currentAngle 当前太阳的位置
 * @param {string} opts.body        主栏 HTML
 * @param {string} [opts.canonical] 规范链接
 */
export function layout({
  title,
  description,
  path: activePath,
  currentAngle,
  body,
  canonical = '',
}) {
  const fullTitle =
    activePath === '/'
      ? `${config.title} · ${config.praise}`
      : `${title} · ${config.title}`;

  return `<!DOCTYPE html>
<html lang="${config.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fullTitle)}</title>
<meta name="description" content="${escapeHtml(description || config.description)}">
<meta name="author" content="${escapeHtml(config.author)}">
<meta name="theme-color" content="#0a0a0a">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/favicon-16.png" sizes="16x16" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:title" content="${escapeHtml(fullTitle)}">
<meta property="og:description" content="${escapeHtml(description || config.description)}">
<meta property="og:type" content="website">
${canonical ? `<link rel="canonical" href="${config.url}${canonical}">` : ''}
<link rel="alternate" type="application/atom+xml" title="${escapeHtml(config.title)}" href="/atom.xml">
<link rel="stylesheet" href="/css/solaire.css">
<script>
(function () {
  try {
    var saved = localStorage.getItem('rail');
    // 无存档时按视口宽度定：1180px 及以下正文会被挤到 584px 以内，默认收起
    var collapsed = saved === null ? window.innerWidth <= 1180 : saved === '1';
    if (collapsed) document.documentElement.classList.add('rail-collapsed');
  } catch (e) {}
})();
</script>
</head>
<body>
<a class="skip" href="#main">跳到正文</a>
<div class="shell">
${rail(activePath)}
<main id="main">
<div class="wrap">
${body}
${footer(currentAngle)}
</div>
</main>
</div>
<script>
(function () {
  var btn = document.querySelector('.railToggle');
  if (!btn) return;
  var root = document.documentElement;
  function sync() {
    var collapsed = root.classList.contains('rail-collapsed');
    btn.setAttribute('aria-expanded', String(!collapsed));
    var label = collapsed ? '展开导航' : '收起导航';
    btn.title = label;
    btn.querySelector('.srOnly').textContent = label;
  }
  btn.addEventListener('click', function () {
    var collapsed = root.classList.toggle('rail-collapsed');
    try { localStorage.setItem('rail', collapsed ? '1' : '0'); } catch (e) {}
    sync();
  });
  sync();
})();
</script>
<script>${lightboxScript}</script>
<script>${copyCodeScript}</script>
</body>
</html>
`;
}

/* ══════════════════════════════════════════════════════════════════
   各页面
   ══════════════════════════════════════════════════════════════════ */

/** 首页：太阳 + 按年分组的索引流 */
export function renderIndex({ posts, groups, currentAngle, tags }) {
  const dominant = tags
    .slice(0, 2)
    .map((t) => `${t.name.toUpperCase()} ${t.count}`)
    .join(' &middot; ');
  const first = posts[posts.length - 1];
  const latest = posts[0];

  const hero = `<section class="hero">
      <div class="heroText">
        <h1>${escapeHtml(config.title)}</h1>
        <p class="praise"><span class="zh">${escapeHtml(config.praise)}</span><span class="cap">${config.praiseEn}</span></p>
        <p class="desc">${escapeHtml(config.intro)}<br>${escapeHtml(config.quote)}</p>
        <div class="rule"></div>
        <dl class="facts">
          <div><dt class="n">${posts.length}</dt><dd class="cap k">entries</dd></div>
          <div><dt class="n">${dotDate(first.date).slice(0, 7)}&mdash;${dotDate(latest.date).slice(0, 7)}</dt><dd class="cap k">span</dd></div>
          <div><dt class="n">${dominant}</dt><dd class="cap k">dominant tags</dd></div>
          <div><dt class="n">${String(currentAngle).padStart(3, '0')}&deg;</dt><dd class="cap k">current sun</dd></div>
        </dl>
      </div>
      ${sunDial(posts, currentAngle)}
    </section>`;

  const body = `${hero}
${sectionLabel('index &mdash; 首页', 'one line per entry &middot; grouped by year-ring')}
${yearIndex(groups, currentAngle)}`;

  return layout({
    title: config.title,
    description: config.description,
    path: '/',
    currentAngle,
    body,
    canonical: '/',
  });
}

/** 文章页：200px 目录轴 + 680px 正文 */
export function renderPost({ post, prev, next, currentAngle }) {
  const toc = post.toc ? tocList(post.headings, config.tocMaxLevel) : '';

  const nav = [];
  if (next)
    nav.push(
      `<a class="pn prev" href="${next.url}"><span class="cap">newer</span><span class="t">${escapeHtml(next.title)}</span></a>`,
    );
  if (prev)
    nav.push(
      `<a class="pn next" href="${prev.url}"><span class="cap">older</span><span class="t">${escapeHtml(prev.title)}</span></a>`,
    );

  const body = `<article class="entry">
      <header class="entryHead">
        <p class="cap crumb"><a href="/">index</a> / entry</p>
        <h1>${escapeHtml(post.title)}</h1>
        <div class="meta">
          <time class="cap14" datetime="${isoDate(post.date)}">${dotDate(post.date)}</time>
          <span class="tags">${post.tags.map(tagPill).join('')}</span>
          <span class="cap">${post.deg}&deg; of ${post.date.getFullYear()}</span>
        </div>
      </header>

      <div class="entryBody">
        <div class="side">
          ${toc}
          <div class="position">
            <p class="cap h">position</p>
            <div class="posRow">
              ${ring({ size: 'r40', angles: [post.angle], sun: post.angle })}
              <span class="cap">${post.deg}&deg;<br>${dotDate(post.date)}</span>
            </div>
          </div>
        </div>
        <div class="prose">
          ${post.body}
          ${nav.length ? `<nav class="pnnav">${nav.join('')}</nav>` : ''}
        </div>
      </div>
    </article>`;

  return layout({
    title: post.title,
    description: post.excerpt,
    path: post.url,
    currentAngle,
    body,
    canonical: post.url,
  });
}

/** 归档：全部文章，与首页同一根年轴，但带完整日期 */
export function renderArchive({ posts, groups, currentAngle }) {
  const body = `<header class="pageHead">
      <h1>归档</h1>
      <p class="cap sub">archive &middot; ${posts.length} entries &middot; ${groups.length} years</p>
    </header>
${sectionLabel('archive &mdash; 归档', 'grouped by year-ring')}
${yearIndex(groups, currentAngle, { showYear: true })}`;

  return layout({
    title: '归档',
    description: `${config.title}的全部 ${posts.length} 篇文章归档。`,
    path: '/archives/',
    currentAngle,
    body,
    canonical: '/archives/',
  });
}

/** 标签总览：标签作为一组环，每个环画出该标签下文章的角度分布 */
export function renderTags({ tags, currentAngle }) {
  const cards = tags
    .map((t) => {
      const angles = [...new Set(t.posts.map((p) => p.angle))];
      return `<li class="tagcard">
        <a href="/tags/${encodeURIComponent(t.name)}/">
          ${ring({ size: 'r56', angles, sun: currentAngle })}
          <span class="name">${escapeHtml(t.name)}</span>
          <span class="cap n">${t.count} ${t.count > 1 ? 'entries' : 'entry'}</span>
        </a>
      </li>`;
    })
    .join('\n');

  const body = `<header class="pageHead">
      <h1>标签</h1>
      <p class="cap sub">tags &middot; ${tags.length} tags</p>
    </header>
${sectionLabel('tags &mdash; 标签', 'ring = angle distribution of its entries')}
    <ul class="taggrid">${cards}</ul>`;

  return layout({
    title: '标签',
    description: `${config.title}的 ${tags.length} 个标签索引。`,
    path: '/tags/',
    currentAngle,
    body,
    canonical: '/tags/',
  });
}

/** 单个标签页 */
export function renderTag({ tag, groups, currentAngle }) {
  const body = `<header class="pageHead">
      <h1>${escapeHtml(tag.name)}</h1>
      <p class="cap sub">tag &middot; ${tag.count} ${tag.count > 1 ? 'entries' : 'entry'} &middot; <a href="/tags/">all tags</a></p>
    </header>
${sectionLabel(`${escapeHtml(tag.name)} &mdash; 标签`, 'grouped by year-ring')}
${yearIndex(groups, currentAngle, { showYear: true })}`;

  return layout({
    title: `标签 ${tag.name}`,
    description: `${config.title}中标签为 ${tag.name} 的 ${tag.count} 篇文章。`,
    path: '/tags/',
    currentAngle,
    body,
    canonical: `/tags/${encodeURIComponent(tag.name)}/`,
  });
}

/** 关于页：单栏正文，无目录轴 */
export function renderAbout({ page, currentAngle, posts }) {
  const body = `<header class="pageHead">
      <h1>${escapeHtml(page.title || '关于')}</h1>
      <p class="cap sub">about &middot; ${escapeHtml(config.author)}</p>
    </header>
${sectionLabel('about &mdash; 关于')}
    <div class="entryBody single">
      <div class="prose">${page.body}</div>
    </div>`;

  return layout({
    title: '关于',
    description: `关于${escapeHtml(config.author)}与${escapeHtml(config.title)}。`,
    path: '/about/',
    currentAngle,
    body,
    canonical: '/about/',
  });
}

/** 404 */
export function render404({ currentAngle }) {
  const body = `<header class="pageHead">
      <h1>404</h1>
      <p class="cap sub">这个角度上没有东西 &middot; nothing at this angle</p>
    </header>
${sectionLabel('404 &mdash; 未找到')}
    <p class="notfound">页面不存在，或者已经移动。回到 <a href="/">索引</a>。</p>`;

  return layout({
    title: '404',
    description: '页面不存在。',
    path: '/404',
    currentAngle,
    body,
  });
}

/** Atom feed */
export function renderFeed({ posts }) {
  const updated = posts[0].date.toISOString();
  const entries = posts
    .slice(0, 20)
    .map(
      (p) => `  <entry>
    <title>${escapeHtml(p.title)}</title>
    <link href="${config.url}${p.url}"/>
    <id>${config.url}${p.url}</id>
    <published>${p.date.toISOString()}</published>
    <updated>${p.date.toISOString()}</updated>
    <summary>${escapeHtml(p.excerpt)}</summary>
${p.tags.map((t) => `    <category term="${escapeHtml(t)}"/>`).join('\n')}
  </entry>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeHtml(config.title)}</title>
  <subtitle>${escapeHtml(config.praise)}</subtitle>
  <link href="${config.url}/atom.xml" rel="self"/>
  <link href="${config.url}/"/>
  <updated>${updated}</updated>
  <id>${config.url}/</id>
  <author><name>${escapeHtml(config.author)}</name></author>
${entries}
</feed>
`;
}

/** sitemap */
export function renderSitemap({ posts, tags }) {
  const urls = [
    '/',
    '/archives/',
    '/tags/',
    '/about/',
    ...posts.map((p) => p.url),
    ...tags.map((t) => `/tags/${encodeURIComponent(t.name)}/`),
  ];
  return `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${config.url}${u}</loc></url>`).join('\n')}
</urlset>
`;
}
