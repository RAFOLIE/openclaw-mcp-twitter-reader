import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import CDP from "chrome-remote-interface";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import * as fs from "fs";
import * as path from "path";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const CDP_URL = process.env.CDP_URL || "http://localhost:18800";

// ============================================================
// CDP helpers
// ============================================================

async function getPageWsUrl(): Promise<string> {
  const baseUrl = CDP_URL.replace(/\/$/, "");
  const httpUrl = baseUrl.startsWith("ws") ? baseUrl.replace(/^ws/, "http") : baseUrl;
  const res = await fetch(httpUrl + "/json");
  const pages = (await res.json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
    url: string;
    title: string;
    id: string;
  }>;
  const target = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
  if (!target) throw new Error("No browser page found at " + baseUrl);
  return target.webSocketDebuggerUrl;
}

/** Run CDP commands on the target page */
async function withCdp<T>(fn: (client: CDP.Client) => Promise<T>): Promise<T> {
  const wsUrl = await getPageWsUrl();
  const client = await CDP({ target: wsUrl });
  try {
    await client.Page.enable();
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Wait for specified ms */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// get_tweet (with images)
// ============================================================

interface TweetImage { fileName: string; src: string }

async function getTweetContent(url: string, includeImages: boolean = false): Promise<{ text: string; images?: TweetImage[]; error?: string }> {
  try {
    return await withCdp(async (client) => {
      await client.Page.navigate({ url });
      await sleep(5000);

      // Click "Show more" up to 5 times
      for (let i = 0; i < 5; i++) {
        const { result } = await client.Runtime.evaluate({
          expression: `document.querySelectorAll('[data-testid="tweet-text-show-more-link"]').length`,
        });
        const count = (result as any).value;
        if (count === 0) break;
        await client.Runtime.evaluate({
          expression: `document.querySelector('[data-testid="tweet-text-show-more-link"]').click()`,
        });
        await sleep(2000);
      }

      // Extract tweet content
      const { result } = await client.Runtime.evaluate({
        expression: `(function() {
          const articles = document.querySelectorAll('article[data-testid="tweet"]');
          if (!articles.length) return null;
          const main = articles[0];
          const userEl = main.querySelector('[data-testid="User-Name"]');
          const author = userEl ? userEl.textContent.trim() : '';
          const timeEl = main.querySelector('time');
          const time = timeEl ? timeEl.textContent.trim() : '';
          const texts = [];
          main.querySelectorAll('[data-testid="tweetText"]').forEach(function(el) {
            const t = el.textContent.trim();
            if (t) texts.push(t);
          });
          var allArticles = main.querySelectorAll("article[data-testid='tweet']");
          if (allArticles.length > 1) {
            texts.push('\\n--- 引用推文 ---');
            var quoted = allArticles[1];
            quoted.querySelectorAll('[data-testid="tweetText"]').forEach(function(el) {
              var t = el.textContent.trim();
              if (t) texts.push(t);
            });
            var qUser = quoted.querySelector('[data-testid="User-Name"]');
            if (qUser) texts.push(qUser.textContent.trim());
          }
          var reply = main.querySelector('[data-testid="reply"]');
          var retweet = main.querySelector('[data-testid="retweet"]');
          var like = main.querySelector('[data-testid="like"]');
          // Detect quoted tweet: look for a role="link" div with a different user
          var quotedHandle = '';
          var quotedLinkHref = '';
          var mainHandle = (author.split('@')[1] || '').trim();
          main.querySelectorAll('[role="link"]').forEach(function(d) {
            var text = d.textContent || '';
            var href = d.getAttribute('href') || '';
            // Quoted tweet card has text like "User@handle·date" followed by content
            // and is NOT the main tweet's own links
            if (text.includes('@') && text.indexOf('@' + mainHandle) === -1) {
              var handleMatch = text.match(/@([A-Za-z0-9_]+)/);
              if (handleMatch) {
                quotedHandle = handleMatch[1];
                quotedLinkHref = href;
              }
            }
          });
          return JSON.stringify({
            author: author,
            time: time,
            content: texts.join('\\n\\n'),
            quotedHandle: quotedHandle,
            quotedLinkHref: quotedLinkHref,
            replies: reply ? reply.getAttribute('aria-label') : '',
            retweets: retweet ? retweet.getAttribute('aria-label') : '',
            likes: like ? like.getAttribute('aria-label') : '',
          });
        })()`,
      });

      const parsed = JSON.parse((result as any).value);
      if (!parsed) return { text: "", error: "未找到推文内容" };

      // Image download tracking (scope: withCdp callback)
      let downloadedImages: Array<{ fileName: string; src: string }> = [];

      // Check for quoted tweet and fetch full content
      let quotedContent: string | null = null;
      if (parsed.quotedHandle) {
        // The quoted tweet card doesn't have a direct href, navigate by handle
        const quotedUrl = "https://x.com/" + parsed.quotedHandle;
        // First, try clicking the quoted tweet card to navigate there
        const { result: clickResult } = await client.Runtime.evaluate({
          expression: `(function() {
            var main = document.querySelector('article[data-testid="tweet"]');
            if (!main) return JSON.stringify({clicked: false});
            var target = null;
            main.querySelectorAll('[role="link"]').forEach(function(d) {
              var text = d.textContent || '';
              if (text.includes('@${parsed.quotedHandle}') && text.includes('文章')) {
                target = d;
              }
            });
            if (target) {
              target.click();
              return JSON.stringify({clicked: true});
            }
            return JSON.stringify({clicked: false});
          })()`,
        });
        const clickParsed = JSON.parse((clickResult as any).value);
        if (clickParsed?.clicked) {
          await sleep(4000);
        } else {
          // Fallback: direct navigate
          await client.Page.navigate({ url: quotedUrl });
          await sleep(4000);
        }

        // Click "Show more" on quoted tweet
        for (let i = 0; i < 5; i++) {
          const { result: smCount } = await client.Runtime.evaluate({
            expression: `document.querySelectorAll('[data-testid="tweet-text-show-more-link"]').length`,
          });
          if ((smCount as any).value === 0) break;
          await client.Runtime.evaluate({
            expression: `document.querySelector('[data-testid="tweet-text-show-more-link"]').click()`,
          });
          await sleep(2000);
        }

        // Extract quoted tweet full content
        // When includeImages, scroll to load all images first
        if (includeImages) {
          for (let si = 0; si < 12; si++) {
            await client.Runtime.evaluate({ expression: "window.scrollBy(0, 1500)" });
            await sleep(1500);
          }
          await client.Runtime.evaluate({ expression: "window.scrollTo(0, 0)" });
          await sleep(1000);
        }

        const treeWalkerJS = includeImages ? `
            if (isLongForm) {
              var imgIdx = 0, blocks = [], textBuf = '';
              function flush() { if (textBuf.trim()) { blocks.push({t:'text',v:textBuf.trim()}); textBuf=''; } }
              var cDiv = null;
              main.querySelectorAll('div').forEach(function(d) {
                if (!cDiv && d.querySelectorAll('h1').length >= 2 && d.querySelectorAll('img[src*="pbs.twimg.com/media/"]').length >= 2) cDiv = d;
              });
              var root = cDiv || main;
              var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
              var n;
              while (n = walker.nextNode()) {
                var tag = n.tagName.toLowerCase();
                if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
                  flush(); var lv = tag === 'h1' ? '#' : tag === 'h2' ? '##' : '###';
                  blocks.push({t:'h', v: lv + ' ' + n.textContent.trim()});
                } else if (tag === 'pre') {
                  flush(); blocks.push({t:'code', v: n.textContent.trim()});
                } else if (tag === 'ul' || tag === 'ol') {
                  flush(); var items = [];
                  n.querySelectorAll(':scope > li').forEach(function(li) { items.push(li.textContent.trim()); });
                  blocks.push({t:'list', ord: tag === 'ol', items: items});
                } else if (tag === 'img') {
                  var src = n.getAttribute('src') || '';
                  if (src.includes('pbs.twimg.com/media/')) {
                    flush(); imgIdx++;
                    var ext = src.match(/format=(\\w+)/) ? src.match(/format=(\\w+)/)[1] : 'jpg';
                    blocks.push({t:'img', idx: imgIdx, ext: ext === 'png' ? 'png' : 'jpg', src: src.replace(/name=[^&]+/, 'name=large')});
                  }
                } else if (tag === 'blockquote') {
                  flush(); blocks.push({t:'quote', v: n.textContent.trim()});
                }
              }
              flush();
              return JSON.stringify({author: author, time: time, url: location.href, isLongForm: true, imgCount: imgIdx, blocks: blocks});
            }
            ` : "";

        const { result: quotedResult } = await client.Runtime.evaluate({
          expression: `(function() {
            var articles = document.querySelectorAll('article[data-testid="tweet"]');
            if (!articles.length) return null;
            var main = articles[0];
            var userEl = main.querySelector('[data-testid="User-Name"]');
            var author = userEl ? userEl.textContent.trim() : '';
            var timeEl = main.querySelector('time');
            var time = timeEl ? timeEl.textContent.trim() : '';
            var tweetTexts = [];
            main.querySelectorAll('[data-testid="tweetText"]').forEach(function(el) {
              var t = el.textContent.trim();
              if (t) tweetTexts.push(t);
            });
            var isLongForm = tweetTexts.join('').length < 50 && main.querySelectorAll('h1').length >= 2;
            ${treeWalkerJS}
            var content = tweetTexts.join('\\n\\n');
            if (content.length < 50) content = main.textContent.trim();
            return JSON.stringify({author: author, time: time, url: location.href, isLongForm: false, content: content});
          })()`,
        });

        const quotedParsed = JSON.parse((quotedResult as any).value);
        if (quotedParsed) {
          if (quotedParsed.isLongForm && quotedParsed.blocks) {
            const mdLines: string[] = [];
            for (const b of quotedParsed.blocks) {
              switch (b.t) {
                case "h": mdLines.push(b.v); break;
                case "text": mdLines.push(b.v); break;
                case "code": mdLines.push("```\n" + b.v + "\n```"); break;
                case "list":
                  (b.items as string[]).forEach((item, idx) => {
                    mdLines.push((b.ord ? `${idx + 1}. ` : "- ") + item);
                  });
                  break;
                case "img": {
                  const fileName = `image_${String(b.idx).padStart(2, "0")}.${b.ext}`;
                  mdLines.push("", `![${fileName}](${fileName})`, "");
                  downloadedImages.push({ fileName, src: (b as any).src });
                  break;
                }
                case "quote": mdLines.push("> " + b.v); break;
              }
            }
            quotedContent = [
              "## " + quotedParsed.author,
              "📅 " + quotedParsed.time,
              "🔗 " + quotedParsed.url,
              "",
              mdLines.join("\n\n"),
            ].join("\n");
          } else {
            quotedContent = [
              "## " + quotedParsed.author,
              "📅 " + quotedParsed.time,
              "🔗 " + quotedParsed.url,
              "",
              quotedParsed.content,
            ].join("\n");
          }
        }
      }

      // Build final output
      const parts: string[] = [
        "## " + parsed.author,
        "📅 " + parsed.time,
        "",
        parsed.content,
        "",
        "---",
        "💬 " + parsed.replies + "  🔁 " + parsed.retweets + "  ❤️ " + parsed.likes,
      ];

      if (quotedContent) {
        parts.push("", "═══ 引用推文全文 ═══", "");
        parts.push(quotedContent);
      }

      return { text: parts.join("\n"), images: downloadedImages };
    });
  } catch (err: any) {
    return { text: "", error: err.message };
  }
}

// ============================================================
// get_timeline
// ============================================================

async function getTimeline(count: number = 10): Promise<{ text: string; error?: string }> {
  try {
    return await withCdp(async (client) => {
      await client.Page.navigate({ url: "https://x.com/home" });
      await sleep(5000);

      // Scroll to load more
      for (let i = 0; i < 3; i++) {
        await client.Runtime.evaluate({ expression: "window.scrollBy(0, 2000)" });
        await sleep(2000);
      }

      const { result } = await client.Runtime.evaluate({
        expression: `(function(maxCount) {
          var articles = document.querySelectorAll('article[data-testid="tweet"]');
          var results = [];
          articles.forEach(function(article) {
            if (results.length >= maxCount) return;
            var parent = article.closest("article[data-testid='tweet']");
            if (parent && parent !== article) return;
            var nameEl = article.querySelector('[data-testid="User-Name"]');
            var author = nameEl ? nameEl.textContent.trim() : '';
            var links = article.querySelectorAll("a[href^='/']");
            var handle = '';
            links.forEach(function(a) {
              var href = a.getAttribute('href');
              if (href && /^\\/[A-Za-z0-9_]+$/.test(href)) handle = href.replace('/', '');
            });
            var timeEl = article.querySelector('time');
            var time = timeEl ? timeEl.textContent.trim() : '';
            var statusLink = timeEl ? timeEl.closest('a') : null;
            var href = statusLink ? statusLink.getAttribute('href') : null;
            var url = href ? 'https://x.com' + href : '';
            var texts = [];
            article.querySelectorAll('[data-testid="tweetText"]').forEach(function(el) {
              var t = el.textContent.trim();
              if (t) texts.push(t);
            });
            var likeEl = article.querySelector('[data-testid="like"]');
            var fullContent = texts.join('\\n');
            var preview = fullContent.length > 200 ? fullContent.slice(0, 200) + '...' : fullContent;
            if (url && handle) {
              results.push({
                author: author.replace(handle, '').trim().split('\\n')[0],
                handle: handle, time: time, content: preview, url: url,
                likes: likeEl ? likeEl.getAttribute('aria-label') : '',
              });
            }
          });
          return JSON.stringify(results);
        })(${count})`,
      });

      const tweets = JSON.parse((result as any).value);
      if (!tweets.length) return { text: "", error: "未获取到推文" };

      const lines = tweets.map(
        (t: any, i: number) =>
          (i + 1) + ". **@" + t.handle + "** — " + t.content + "\n   🔗 " + t.url + "\n   ❤️ " + t.likes + " · " + t.time,
      );
      return { text: ["🐦 推文速览", "", ...lines].join("\n") };
    });
  } catch (err: any) {
    return { text: "", error: err.message };
  }
}

// ============================================================
// get_article
// ============================================================

async function getArticleContent(url: string): Promise<{ text: string; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { text: "", error: "HTTP " + res.status };
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return { text: "", error: "无法解析文章内容" };
    const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    const md = turndown.turndown(article.content);
    const parts: string[] = ["# " + article.title, ""];
    if (article.excerpt) parts.push("> " + article.excerpt);
    parts.push("> 来源: " + (article.siteName || url));
    parts.push("", md);
    return { text: parts.join("\n") };
  } catch (err: any) {
    const msg = err.message || "";
    if (msg.includes("fetch") || msg.includes("network") || msg.includes("abort") || msg.includes("ECONNREFUSED")) {
      return await getArticleViaBrowser(url);
    }
    return { text: "", error: msg };
  }
}

async function getArticleViaBrowser(url: string): Promise<{ text: string; error?: string }> {
  try {
    return await withCdp(async (client) => {
      await client.Page.navigate({ url });
      await sleep(3000);
      const { result } = await client.Runtime.evaluate({
        expression: `(function() {
          var selectors = ['article', '.article-content', '.post-content', 'main'];
          for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el && el.textContent && el.textContent.trim().length > 200) {
              return JSON.stringify({ title: document.title, content: el.textContent.trim() });
            }
          }
          return JSON.stringify({ title: document.title, content: (document.body ? document.body.textContent.trim() : '').slice(0, 50000) });
        })()`,
      });
      const parsed = JSON.parse((result as any).value);
      return { text: "# " + parsed.title + "\n\n" + parsed.content };
    });
  } catch (err: any) {
    return { text: "", error: err.message };
  }
}

// ============================================================
// download_tweet_images
// ============================================================

/** Fetch with proxy support (pbs.twimg.com needs proxy in China) */
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || "";
const dispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

async function fetchWithProxy(url: string): Promise<Response> {
  if (dispatcher) {
    return undiciFetch(url, { dispatcher } as any) as unknown as Response;
  }
  return globalThis.fetch(url);
}

async function downloadTweetImages(
  url: string,
  outputDir: string = "./images",
): Promise<{ text: string; error?: string }> {
  try {
    // Ensure output dir exists
    const absDir = path.resolve(outputDir);
    if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });

    return await withCdp(async (client) => {
      await client.Page.navigate({ url });
      await sleep(5000);

      // Wait for tweet to load
      for (let wait = 0; wait < 3; wait++) {
        const { result: checkResult } = await client.Runtime.evaluate({
          expression: `document.querySelectorAll('article[data-testid="tweet"]').length`,
        });
        if ((checkResult as any).value > 0) break;
        await sleep(3000);
      }

      // Extract image URLs (exclude avatars/profiles/emoji)
      const { result } = await client.Runtime.evaluate({
        expression: `(function() {
          var articles = document.querySelectorAll('article[data-testid="tweet"]');
          if (!articles.length) return null;
          var main = articles[0];
          var imgs = main.querySelectorAll('img');
          var mediaUrls = [];
          var seen = {};
          imgs.forEach(function(img) {
            var src = img.getAttribute('src') || '';
            // Keep only media images, skip avatars/profiles/emoji
            if (src.includes('pbs.twimg.com/media/') || src.includes('pbs.twimg.com/amplify_video_thumb/')) {
              var base = src.split('?')[0];
              if (!seen[base]) {
                seen[base] = true;
                // Upgrade to large format
                var large = src.replace(/name=[^&]+/, 'name=large');
                mediaUrls.push(large);
              }
            }
          });
          return JSON.stringify(mediaUrls);
        })()`,
      });

      const urls: string[] | null = JSON.parse((result as any).value);
      if (!urls) return { text: "", error: "未找到推文" };
      if (urls.length === 0) return { text: "该推文没有配图" };

      // Download images from Node.js (pbs.twimg.com doesn't need cookies)
      const downloaded: string[] = [];
      for (let i = 0; i < urls.length; i++) {
        try {
          const imgUrl = urls[i];
          const ext = imgUrl.match(/format=(\w+)/)?.[1] || "jpg";
          const fileName = `image_${String(i + 1).padStart(2, "0")}.${ext === "png" ? "png" : "jpg"}`;
          const filePath = path.join(absDir, fileName);

          const res = await fetchWithProxy(imgUrl);
          if (!res.ok) continue;
          const buffer = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(filePath, buffer);
          downloaded.push(filePath);
        } catch {
          // Skip failed images silently
        }
      }

      if (downloaded.length === 0) return { text: "图片下载失败" };
      return {
        text: [
          "🖼️ 下载完成：" + downloaded.length + " 张图片",
          "",
          "📁 目录：" + absDir,
          ...downloaded.map((f) => "  - " + f),
        ].join("\n"),
      };
    });
  } catch (err: any) {
    return { text: "", error: err.message };
  }
}

// ============================================================
// MCP Server
// ============================================================

const server = new Server(
  { name: "twitter-reader", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_tweet",
      description: "获取推文完整内容。支持 include_images=true 时，自动提取引用推文全文和配图，返回带图片引用的 Markdown。",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: "string" as const, description: "推文 URL" },
          include_images: { type: "boolean" as const, description: "是否提取配图，默认 false" },
          output_dir: { type: "string" as const, description: "图片保存目录，默认 ./images" },
        },
        required: ["url"],
      },
    },
    {
      name: "get_timeline",
      description: "获取 X 推荐首页推文列表。",
      inputSchema: {
        type: "object" as const,
        properties: { count: { type: "number" as const, description: "推文数量，默认 10" } },
      },
    },
    {
      name: "get_article",
      description: "获取外部文章完整内容。Readability + Markdown。",
      inputSchema: {
        type: "object" as const,
        properties: { url: { type: "string" as const, description: "文章 URL" } },
        required: ["url"],
      },
    },
    {
      name: "download_tweet_images",
      description: "下载推文中的配图到本地。自动排除头像，只保存媒体图片（原图）。",
      inputSchema: {
        type: "object" as const,
        properties: {
          url: { type: "string" as const, description: "推文 URL" },
          output_dir: { type: "string" as const, description: "保存目录，默认 ./images" },
        },
        required: ["url"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "get_tweet") {
    const url = args?.url as string;
    if (!url) return { content: [{ type: "text", text: "Error: url is required" }] };
    const includeImages = args?.include_images as boolean || false;
    const outputDir = (args?.output_dir as string) || "./images";
    const r = await getTweetContent(url, includeImages);
    // Download images if requested
    if (includeImages && r.images && r.images.length > 0) {
      const absDir = path.resolve(outputDir);
      if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
      const saved: string[] = [];
      for (const img of r.images) {
        try {
          const res = await fetchWithProxy(img.src);
          if (!res.ok) continue;
          const buffer = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(path.join(absDir, img.fileName), buffer);
          saved.push(img.fileName);
        } catch { /* skip */ }
      }
      if (saved.length > 0) {
        const footer = "\n\n---\n🖼️ " + saved.length + " 张图片已保存到 " + absDir;
        return { content: [{ type: "text", text: (r.error ? "Error: " + r.error : r.text + footer) }] };
      }
    }
    return { content: [{ type: "text", text: r.error ? "Error: " + r.error : r.text }] };
  }
  if (name === "get_timeline") {
    const count = (args?.count as number) || 10;
    const r = await getTimeline(count);
    return { content: [{ type: "text", text: r.error ? "Error: " + r.error : r.text }] };
  }
  if (name === "get_article") {
    const url = args?.url as string;
    if (!url) return { content: [{ type: "text", text: "Error: url is required" }] };
    const r = await getArticleContent(url);
    return { content: [{ type: "text", text: r.error ? "Error: " + r.error : r.text }] };
  }
  if (name === "download_tweet_images") {
    const url = args?.url as string;
    if (!url) return { content: [{ type: "text", text: "Error: url is required" }] };
    const outputDir = (args?.output_dir as string) || "./images";
    const r = await downloadTweetImages(url, outputDir);
    return { content: [{ type: "text", text: r.error ? "Error: " + r.error : r.text }] };
  }
  return { content: [{ type: "text", text: "Unknown tool: " + name }] };
});

// ============================================================
// CLI
// ============================================================

async function cliMain() {
  const command = process.argv[2];
  const arg = process.argv[3];
  if (!command || command === "--help" || command === "-h") {
    console.error("Usage: mcp-twitter-reader <command> [args]");
    console.error("  get-tweet <url> [--images] [--dir <path>]  获取推文内容（--images 下载配图）");
    console.error("  get-timeline [count]   获取首页推文列表");
    console.error("  get-article <url>      获取文章完整内容");
    console.error("  download-images <url> [dir] 下载推文配图");
    process.exit(command ? 0 : 1);
  }
  if (command === "get-tweet") {
    if (!arg) { console.error("Error: url is required"); process.exit(1); }
    const withImages = process.argv.includes("--images");
    const dirIdx = process.argv.indexOf("--dir");
    const dir = dirIdx !== -1 && process.argv[dirIdx + 1] ? process.argv[dirIdx + 1] : "./images";
    const r = await getTweetContent(arg, withImages);
    if (withImages && r.images && r.images.length > 0) {
      const absDir = path.resolve(dir);
      if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
      for (const img of r.images) {
        try {
          const res = await fetchWithProxy(img.src);
          if (!res.ok) continue;
          const buffer = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(path.join(absDir, img.fileName), buffer);
        } catch { /* skip */ }
      }
      console.log(r.text + "\n\n---\n🖼️ " + r.images.length + " 张图片已保存到 " + absDir);
    } else {
      console.log(r.error ? "Error: " + r.error : r.text);
    }
    process.exit(r.error ? 1 : 0);
  }
  if (command === "get-timeline") {
    const count = parseInt(arg || "10", 10);
    const r = await getTimeline(count);
    console.log(r.error ? "Error: " + r.error : r.text);
    process.exit(r.error ? 1 : 0);
  }
  if (command === "get-article") {
    if (!arg) { console.error("Error: url is required"); process.exit(1); }
    const r = await getArticleContent(arg);
    console.log(r.error ? "Error: " + r.error : r.text);
    process.exit(r.error ? 1 : 0);
  }
  if (command === "download-images") {
    if (!arg) { console.error("Error: url is required"); process.exit(1); }
    const dir = process.argv[4] || "./images";
    const r = await downloadTweetImages(arg, dir);
    console.log(r.error ? "Error: " + r.error : r.text);
    process.exit(r.error ? 1 : 0);
  }
  console.error("Unknown command: " + command);
  process.exit(1);
}

// ============================================================
// Entry
// ============================================================

if (process.argv.length > 2 && process.argv[2]) {
  cliMain().catch((err) => { console.error("Fatal: " + err.message); process.exit(1); });
} else {
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error("mcp-twitter-reader: MCP server started");
  }).catch((err) => {
    console.error("Fatal: " + err.message);
    process.exit(1);
  });
}
