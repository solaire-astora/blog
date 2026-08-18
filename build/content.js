/**
 * 内容层 —— 读取并解析 source/_posts 下的 Markdown
 *
 * 负责四件事：
 *   1. 解析 front matter（title / date / tags / toc）
 *   2. 渲染正文，同时收集标题以生成目录轴
 *   3. 处理这批文章特有的两个写法：Obsidian 的 ![img|300](url) 宽度语法、
 *      以及大小写混杂的代码块语言标记（C++ / cpp / c++ 都指同一种）
 *   4. 把 :::diagram 块替换为 source/diagrams 下同名 SVG 的内联内容
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

import { sunAngle, sunDeg } from './sun.js';

/** 代码块语言标记归一化 —— 作者在 19 篇里混用了 8 种写法 */
const LANG_ALIAS = {
  'c++': 'cpp',
  cpp: 'cpp',
  protobuf: 'protobuf',
  shell: 'bash',
  bash: 'bash',
  txt: 'plaintext',
  yaml: 'yaml',
  rust: 'rust',
  java: 'java',
  lua: 'lua',
  cmake: 'cmake',
  go: 'go',
  redis: 'plaintext',
  dockerfile: 'dockerfile',
};

function normalizeLang(info) {
  const lang = (info || '').trim().toLowerCase();
  return LANG_ALIAS[lang] || lang;
}

/** 剥掉行内 Markdown 标记，只留可读文字（供目录与锚点用） */
function plainInline(text) {
  return text
    .replace(/`([^`]*)`/g, '$1') // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** 标题文本 → 锚点 id。中文标题保留原字，仅替换空白与标点 */
function slugify(text, seen) {
  let slug = text
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
  if (!slug) slug = 'section';

  // 同名标题去重
  const count = seen.get(slug) || 0;
  seen.set(slug, count + 1);
  return count === 0 ? slug : `${slug}-${count + 1}`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 内联 SVG 图表。
 *
 * 正文里写：
 *     :::diagram 07-full-chain
 *     at(int) 的完整调用链
 *     :::
 * 第一行是 source/diagrams/ 下的文件名（可省略 .svg），其后可选一行图注。
 *
 * SVG 直接内联而不用 <img>，因为这样它才能继承页面的字体栈与 currentColor，
 * 且不额外发一次请求；图注用 mono caption，与设计语言里的 eyebrow 同一角色。
 */
function inlineDiagram(diagramsDir, name, caption, seenDiagrams) {
  const file = name.endsWith('.svg') ? name : `${name}.svg`;
  const full = path.join(diagramsDir, file);

  if (!fs.existsSync(full)) {
    throw new Error(`引用了不存在的图表：source/diagrams/${file}`);
  }

  // 去掉 XML 声明与 DOCTYPE，只留 <svg> 元素本身
  let svg = fs
    .readFileSync(full, 'utf8')
    .replace(/<\?xml[^>]*\?>\s*/g, '')
    .replace(/<!DOCTYPE[^>]*>\s*/g, '')
    .trim();

  // 同一张图在一篇文章里被引用多次时（如 prometheus-hpa 的架构图在正文与
  // 总结各出现一次），内联两份会让 id 撞车：aria-labelledby 会指向第一张的
  // title（屏幕阅读器把第二张念成第一张），marker 也可能解析到错误定义。
  // 所以第二次及以后出现时给所有 id 及其引用加序号后缀。
  const count = (seenDiagrams.get(file) || 0) + 1;
  seenDiagrams.set(file, count);

  if (count > 1) {
    const suffix = '-r' + count;
    const ids = new Set(
      [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]),
    );
    for (const id of ids) {
      const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const tail = id + suffix;
      svg = svg
        .replace(new RegExp('(\\sid=")' + esc + '(")', 'g'), '$1' + tail + '$2')
        .replace(new RegExp('(url\\(#)' + esc + '(\\))', 'g'), '$1' + tail + '$2')
        // aria-labelledby 里是空格分隔的多个 id
        .replace(
          new RegExp('(aria-labelledby="[^"]*?)' + esc + '\\b', 'g'),
          '$1' + tail,
        );
    }
  }

  return `<figure class="diagram">${svg}${
    caption ? `<figcaption class="cap">${escapeHtml(caption)}</figcaption>` : ''
  }</figure>\n`;
}

/**
 * 创建 markdown-it 实例。
 * headings 数组由调用方传入，渲染过程中被填充 —— 目录轴需要它。
 * diagramsDir 为 SVG 图表目录，:::diagram 块从这里取文件。
 * postIndex 是 slug → { url, title } 的映射，供 {% post_link %} 解析站内链接。
 */
function createRenderer(headings, diagramsDir, postIndex = new Map()) {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    highlight(code, lang) {
      const normalized = normalizeLang(lang);
      let body;
      if (normalized && hljs.getLanguage(normalized)) {
        try {
          body = hljs.highlight(code, {
            language: normalized,
            ignoreIllegals: true,
          }).value;
        } catch {
          body = escapeHtml(code);
        }
      } else {
        body = escapeHtml(code);
      }
      // 语言标记先放在 pre 内，运行时由脚本连同 pre 一起移进 .codeBlock 外层。
      //
      // 这里必须返回以 `<pre` 开头的字符串 —— markdown-it 的 highlight 钩子
      // 只在返回值以 <pre 开头时才认为「整个代码块已由钩子渲染完」，否则会
      // 把返回值当作代码内容，再套一层自己的 <pre><code>。返回 <div> 开头
      // 会导致 .codeBlock 被嵌套进 pre 里。
      const label = normalized
        ? `<span class="code-lang">${escapeHtml(normalized)}</span>`
        : '';
      return `<pre class="code">${label}<code class="hljs">${body}</code></pre>`;
    },
  });

  // 标题：整体下沉一级并挂锚点 id，同时收集进 headings 供目录轴使用。
  //
  // 作者的正文用 # 作章节标题，而页面上 h1 留给标题区，
  // 所以正文标题下沉一级：# → h2、## → h3，保持文档大纲正确。
  const seen = new Map();
  md.core.ruler.push('solaire_headings', function (state) {
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== 'heading_open') continue;

      const level = Number(token.tag.slice(1));
      const inline = state.tokens[i + 1];
      const raw = inline && inline.type === 'inline' ? inline.content : '';
      // inline.content 是原始 Markdown。作者的标题里大量出现
      // `std::memory_order_release` 这样的行内代码，直接进目录会带着反引号，
      // 所以剥掉行内语法只留文字 —— 目录要的是标题的读法，不是它的标记。
      const text = plainInline(raw);
      const id = slugify(text, seen);
      const tag = `h${Math.min(level + 1, 6)}`;

      token.tag = tag;
      token.attrSet('id', id);
      // 配对的 heading_close 紧跟在 inline 之后
      const closing = state.tokens[i + 2];
      if (closing && closing.type === 'heading_close') closing.tag = tag;

      headings.push({ level, id, text });
    }
  });

  // 图片：拆掉 Obsidian 的 ![name|300](url) 宽度语法，宽度落到 style 上。
  //
  // 不带宽度语法的图默认撑满正文栏（680px）。但这批截图原始宽度多在
  // 1500–2560px，即使满栏也只有三成大小（火焰图、时序图尤甚），所以给它们
  // 套一个指向原图的链接，读者可以点开看原尺寸。表情包这类小图不需要。
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const alt = token.content || '';
    let explicitWidth = null;

    const bar = alt.lastIndexOf('|');
    if (bar > -1) {
      const width = alt.slice(bar + 1).trim();
      if (/^\d+$/.test(width)) {
        explicitWidth = Number(width);
        const clean = alt.slice(0, bar);
        token.content = clean;
        token.attrSet('style', `max-width:${width}px`);
        // alt 文本由 children 渲染，必须同步改这里，否则 alt 会带上 "|198"
        if (token.children && token.children.length) {
          for (const child of token.children) {
            if (child.type === 'text') child.content = clean;
          }
        }
      }
    }
    token.attrSet('loading', 'lazy');

    const html = defaultImage(tokens, idx, options, env, self);
    const src = token.attrGet('src') || '';

    // 显式限过宽度的（表情包等小图）不加链接：它们本来就是完整可见的
    if (explicitWidth !== null || !/^https?:\/\//.test(src)) return html;

    return `<a class="imgLink" href="${src}" target="_blank" rel="noopener" title="点击查看原图">${html}</a>`;
  };

  // 外链新窗口打开
  const defaultLinkOpen =
    md.renderer.rules.link_open ||
    function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options, env, self);
    };
  md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
    const href = tokens[idx].attrGet('href') || '';
    if (/^https?:\/\//.test(href)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener');
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  // :::diagram <name> / 可选图注 / ::: —— 块级规则，内联 source/diagrams 下的 SVG
  md.block.ruler.before('fence', 'solaire_diagram', function (state, startLine, endLine, silent) {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const opening = state.src.slice(start, max).trim();

    const match = opening.match(/^:::\s*diagram\s+(\S+)\s*$/);
    if (!match) return false;
    if (silent) return true;

    // 往下找收尾的 :::
    let nextLine = startLine;
    let closed = false;
    while (++nextLine < endLine) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineText = state.src.slice(lineStart, state.eMarks[nextLine]).trim();
      if (lineText === ':::') {
        closed = true;
        break;
      }
    }
    if (!closed) return false;

    // 开合之间的非空行作为图注
    const caption = state.src
      .slice(state.bMarks[startLine + 1] ?? 0, state.eMarks[nextLine - 1] ?? 0)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');

    const token = state.push('solaire_diagram', 'figure', 0);
    token.map = [startLine, nextLine + 1];
    token.info = match[1];
    token.content = caption;
    token.block = true;

    state.line = nextLine + 1;
    return true;
  });

  // 每个 renderer 实例对应一篇文章，故计数天然按文章隔离
  const seenDiagrams = new Map();
  md.renderer.rules.solaire_diagram = function (tokens, idx) {
    return inlineDiagram(
      diagramsDir,
      tokens[idx].info,
      tokens[idx].content,
      seenDiagrams,
    );
  };

  // {% post_link <slug> [自定义文字] %} —— Hexo 的站内文章链接语法。
  //
  // 写成 inline 规则而不是预处理时的字符串替换：这样它天然只在正文里生效，
  // 代码块与行内代码中的同样文本会被原样保留（README 里要讲这个语法本身）。
  md.inline.ruler.before('link', 'solaire_post_link', function (state, silent) {
    if (state.src.charCodeAt(state.pos) !== 0x7b /* { */) return false;
    if (state.src.charCodeAt(state.pos + 1) !== 0x25 /* % */) return false;

    const close = state.src.indexOf('%}', state.pos + 2);
    if (close < 0) return false;

    const inner = state.src.slice(state.pos + 2, close).trim();
    const match = inner.match(/^post_link\s+(\S+)(?:\s+([\s\S]+))?$/);
    if (!match) return false;
    if (!silent) {
      const token = state.push('solaire_post_link', '', 0);
      token.info = match[1];
      token.content = (match[2] || '').trim();
    }
    state.pos = close + 2;
    return true;
  });

  md.renderer.rules.solaire_post_link = function (tokens, idx) {
    const slug = tokens[idx].info;
    const target = postIndex.get(slug);
    if (!target) {
      const known = [...postIndex.keys()].sort().join(', ');
      throw new Error(
        `post_link 指向了不存在的文章：${slug}\n` +
          `        现有 slug：${known}`,
      );
    }
    // 省略自定义文字时回退到目标文章的标题
    const text = tokens[idx].content || target.title;
    return `<a class="postLink" href="${target.url}">${escapeHtml(text)}</a>`;
  };

  return md;
}

/** 解析 front matter，返回 { data, content } */
function parseFrontMatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: raw };
  // 用 JSON_SCHEMA 让 YAML 时间戳保持字符串原样。
  // 默认 schema 会把 `2025-06-23 21:11:09` 这种无时区写法当 UTC 解析，
  // 在 UTC+8 下读回来就跳到了 6 月 24 日 —— 角度会因此偏 1°。
  // 作者写下的日期就是他所在时区的当地日期，必须按字面值理解。
  return {
    data: yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) || {},
    content: match[2],
  };
}

/**
 * front matter 的日期字符串 → Date（按本地时区理解字面值）
 * 接受 `2025-06-23 21:11:09`、`2025-06-23T21:11:09`、`2025-06-23` 等写法。
 */
function parseLocalDate(value) {
  const text = String(value).trim();
  const m = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (!m) return new Date(NaN);
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0),
  );
}

/** 从正文首段取摘要（供 RSS 与 meta description 用，页面上不显示） */
function firstParagraph(content, postIndex = new Map()) {
  const beforeMore = content.split(/<!--\s*more\s*-->/)[0];
  const text = beforeMore
    .replace(/```[\s\S]*?```/g, '')
    // {% post_link slug 文字 %} → 取自定义文字，省略时取目标文章标题。
    // 这段摘要进 RSS 与 meta description，标签原文漏出去会被订阅器和
    // 搜索引擎直接读到，所以要在剥 markdown 记号之前先化成可读文本。
    .replace(/\{%\s*post_link\s+(\S+)(?:\s+([^%]+?))?\s*%\}/g, (_, slug, label) =>
      (label || postIndex.get(slug)?.title || slug).trim(),
    )
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*`_]/g, '')
    .trim();
  const para = text.split(/\n\s*\n/)[0] || '';
  return para.replace(/\s+/g, ' ').slice(0, 200);
}

/** 文件名 → URL slug */
function fileSlug(filename) {
  return path
    .basename(filename, '.md')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/['"]/g, '');
}

/**
 * 读取全部文章，按日期倒序返回。
 *
 * 分两趟：先读 front matter 建立 slug → { url, title } 索引，再渲染正文。
 * 因为 {% post_link proxy %} 省略文字时要回退到目标文章的标题，渲染任一篇
 * 之前就得知道所有文章的标题。
 */
export function loadPosts(postsDir, diagramsDir) {
  const files = fs
    .readdirSync(postsDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'));

  // 第一趟：解析 front matter，校验必填字段，建索引
  const parsed = files.map((file) => {
    const raw = fs.readFileSync(path.join(postsDir, file), 'utf8');
    const { data, content } = parseFrontMatter(raw);

    if (!data.title) {
      throw new Error(`${file} 缺少 front matter 的 title 字段`);
    }
    if (!data.date) {
      throw new Error(`${file} 缺少 front matter 的 date 字段`);
    }

    const date = parseLocalDate(data.date);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`${file} 的 date 字段无法解析：${data.date}`);
    }

    const slug = fileSlug(file);
    return { file, data, content, date, slug, url: `/posts/${slug}/` };
  });

  const postIndex = new Map(
    parsed.map((p) => [p.slug, { url: p.url, title: String(p.data.title) }]),
  );

  // 第二趟：渲染正文
  const posts = parsed.map(({ file, data, content, date, slug, url }) => {
    const headings = [];
    const md = createRenderer(headings, diagramsDir, postIndex);
    // <!-- more --> 是 Hexo 的摘要分隔标记，本站不显示摘要，直接移除
    let body;
    try {
      body = md.render(content.replace(/<!--\s*more\s*-->/g, ''));
    } catch (err) {
      // 补上出错的文件名 —— 渲染规则里只知道 slug，不知道是谁引用了它
      throw new Error(`${file}：${err.message}`);
    }

    // 自有语法若没被解析规则接住，会原样漏到页面上。下面两道检查在构建期
    // 拦下这种情况，不让坏页面上线。
    //
    // 检查前先剔除 <pre>/<code> 区域 —— 代码块里出现这些语法是正常的
    // （讲解语法本身时就要这么写），那不是失效，剔掉才不会误报。
    const prose = body
      .replace(/<pre[\s\S]*?<\/pre>/g, '')
      .replace(/<code[\s\S]*?<\/code>/g, '');

    // :::diagram 是块级语法，前面缺空行会被当作上一段的延续文本而静默失效
    if (prose.includes(':::diagram')) {
      throw new Error(
        `${file} 里有 :::diagram 块没有生效，渲染成了字面文本。\n` +
          `        原因通常是块前后缺少空行 —— :::diagram 必须独立成段。`,
      );
    }

    // post_link 同理。这里匹配 `{%` 而不是 `{%\s*post_link`：漏出来的文本
    // 已经过 markdown-it 处理，`post_link` 的下划线会被当成斜体标记符吃掉，
    // 变成 `{%postlink ...%}`，拿原始拼写去匹配是找不到的。
    if (/\{%/.test(prose)) {
      const sample = prose.match(/\{%[^}]{0,40}/)?.[0] ?? '{%';
      throw new Error(
        `${file} 里有 Hexo 标签插件没有生效，渲染成了字面文本：${sample}...\n` +
          `        站内文章链接的正确写法：{% post_link <slug> [自定义文字] %}\n` +
          `        注意 {% 与 %} 内侧要留空格。`,
      );
    }

    const tags = Array.isArray(data.tags)
      ? data.tags.map(String)
      : data.tags
        ? [String(data.tags)]
        : [];

    return {
      slug,
      url,
      title: String(data.title),
      date,
      tags,
      toc: data.toc !== false,
      headings,
      body,
      excerpt: firstParagraph(content, postIndex),
      angle: sunAngle(date),
      deg: sunDeg(date),
      sourceFile: file,
    };
  });

  return posts.sort((a, b) => b.date - a.date);
}

/**
 * 汇总标签：按文章数倒序，同数按名称排序。
 */
export function collectTags(posts) {
  const map = new Map();
  for (const post of posts) {
    for (const tag of post.tags) {
      if (!map.has(tag)) map.set(tag, []);
      map.get(tag).push(post);
    }
  }
  return [...map.entries()]
    .map(([name, list]) => ({ name, posts: list, count: list.length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * 读取 source/about/index.md 这类独立页面。
 * posts 传入时，页面里也能用 {% post_link %} 指向文章。
 */
export function loadPage(filePath, diagramsDir, posts = []) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const { data, content } = parseFrontMatter(raw);
  const headings = [];
  const postIndex = new Map(
    posts.map((p) => [p.slug, { url: p.url, title: p.title }]),
  );
  const md = createRenderer(headings, diagramsDir, postIndex);
  let body;
  try {
    body = md.render(content.replace(/<!--\s*more\s*-->/g, ''));
  } catch (err) {
    throw new Error(`${path.basename(filePath)}：${err.message}`);
  }
  return {
    title: data.title ? String(data.title) : '',
    body,
    headings,
  };
}
