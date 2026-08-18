#!/usr/bin/env node
/**
 * 构建 —— 索拉尔的主页
 *
 *   node build/index.js          构建到 public/
 *   node build/index.js --serve  构建后起本地服务并监听改动
 *
 * 管线：读 source/_posts/*.md → 解析 front matter 与正文 → 日期代入设计程式
 * 算出角度 → 套模板生成静态 HTML → 拷贝静态资源。
 *
 * 没有框架、没有主题目录、没有插件系统。整条管线就是这个文件加同目录下的
 * sun.js（程式）、content.js（解析）、templates.js（模板）、solaire.css（样式）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import { sunAngle, groupByYear } from './sun.js';
import { loadPosts, collectTags, loadPage } from './content.js';
import * as T from './templates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SOURCE = path.join(ROOT, 'source');
const POSTS = path.join(SOURCE, '_posts');
const DIAGRAMS = path.join(SOURCE, 'diagrams');
const OUT = path.join(ROOT, 'public');

/* ── 工具 ─────────────────────────────────────────────────────────────── */

function write(relPath, content) {
  const full = path.join(OUT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

/** 目录页写成 <dir>/index.html，保持 URL 结尾带斜杠 */
function writePage(urlPath, html) {
  const rel =
    urlPath === '/'
      ? 'index.html'
      : path.join(urlPath.replace(/^\/|\/$/g, ''), 'index.html');
  return write(rel, html);
}

function copyDir(from, to, skip = () => false) {
  if (!fs.existsSync(from)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (skip(entry.name, src)) continue;
    if (entry.isDirectory()) {
      count += copyDir(src, dest, skip);
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      count++;
    }
  }
  return count;
}

/* ── 构建 ─────────────────────────────────────────────────────────────── */

function build() {
  const started = Date.now();

  const posts = loadPosts(POSTS, DIAGRAMS);
  if (posts.length === 0) throw new Error('source/_posts 下没有找到任何文章');

  const tags = collectTags(posts);
  const groups = groupByYear(posts);
  // 当前太阳的位置 —— 最新一篇文章的角度，全站唯一允许用橙色的地方
  const currentAngle = sunAngle(posts[0].date);

  fs.rmSync(OUT, { recursive: true, force: true });

  let pages = 0;

  // 首页
  writePage('/', T.renderIndex({ posts, groups, currentAngle, tags }));
  pages++;

  // 文章页。posts 已按日期倒序，所以 i+1 更旧、i-1 更新
  posts.forEach((post, i) => {
    writePage(
      post.url,
      T.renderPost({
        post,
        prev: posts[i + 1] || null,
        next: posts[i - 1] || null,
        currentAngle,
      }),
    );
    pages++;
  });

  // 归档
  writePage('/archives/', T.renderArchive({ posts, groups, currentAngle }));
  pages++;

  // 标签总览与各标签页
  writePage('/tags/', T.renderTags({ tags, currentAngle }));
  pages++;
  for (const tag of tags) {
    writePage(
      `/tags/${encodeURIComponent(tag.name)}/`,
      T.renderTag({ tag, groups: groupByYear(tag.posts), currentAngle }),
    );
    pages++;
  }

  // 关于
  const about = loadPage(path.join(SOURCE, 'about', 'index.md'), DIAGRAMS, posts);
  if (about) {
    writePage('/about/', T.renderAbout({ page: about, currentAngle, posts }));
    pages++;
  } else {
    console.warn('  ! source/about/index.md 不存在，跳过关于页');
  }

  // 404
  write('404.html', T.render404({ currentAngle }));
  pages++;

  // feed 与 sitemap
  write('atom.xml', T.renderFeed({ posts }));
  write('sitemap.xml', T.renderSitemap({ posts, tags }));
  write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${config.url}/sitemap.xml\n`);

  // 样式与字体
  write('css/solaire.css', fs.readFileSync(path.join(HERE, 'solaire.css')));
  const fontCount = copyDir(path.join(HERE, 'fonts'), path.join(OUT, 'fonts'));

  // 文章引用的图片等静态资源。跳过 Markdown、Obsidian 配置，以及
  // diagrams 目录 —— 那些 SVG 已内联进 HTML，不必再作为独立文件输出
  const assetCount = copyDir(SOURCE, OUT, (name) => {
    return (
      name === '_posts' ||
      name === 'about' ||
      name === 'diagrams' ||
      name.startsWith('.') ||
      name.endsWith('.md')
    );
  });
  const imageCount = copyDir(
    path.join(SOURCE, 'image'),
    path.join(OUT, 'image'),
    (name) => name === 'banner_img.png',
  );

  const ms = Date.now() - started;
  console.log(
    `构建完成 ${ms}ms\n` +
      `  ${posts.length} 篇文章 · ${tags.length} 个标签 · ${groups.length} 个年份\n` +
      `  ${pages} 个页面 · ${fontCount} 个字体 · ${imageCount + assetCount} 个静态资源\n` +
      `  当前太阳 ${String(currentAngle).padStart(3, '0')}° —— 《${posts[0].title}》\n` +
      `  输出 public/`,
  );

  return { posts, tags, currentAngle };
}

/* ── 本地预览 ─────────────────────────────────────────────────────────── */

async function serve(port = 4000) {
  const http = await import('node:http');

  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };

  http
    .createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(OUT, urlPath);
      if (urlPath.endsWith('/')) file = path.join(file, 'index.html');

      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        const notFound = path.join(OUT, '404.html');
        res.writeHead(404, { 'Content-Type': MIME['.html'] });
        res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : 'Not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      });
      res.end(fs.readFileSync(file));
    })
    .listen(port, () => {
      console.log(`\n预览 http://localhost:${port}\n监听 source/ 与 build/ 的改动，Ctrl-C 退出`);
    });

  // 监听改动重建。debounce 防止编辑器一次保存触发多次
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        build();
      } catch (err) {
        console.error('重建失败：', err.message);
      }
    }, 120);
  };

  for (const dir of [SOURCE, HERE]) {
    fs.watch(dir, { recursive: true }, rebuild);
  }
}

/* ── 入口 ─────────────────────────────────────────────────────────────── */

try {
  build();
  if (process.argv.includes('--serve')) {
    const portArg = process.argv.find((a) => a.startsWith('--port='));
    await serve(portArg ? Number(portArg.split('=')[1]) : 4000);
  }
} catch (err) {
  console.error('构建失败：', err.message);
  process.exitCode = 1;
}
