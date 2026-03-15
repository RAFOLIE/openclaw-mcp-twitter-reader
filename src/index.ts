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
// get_tweet
// ============================================================

async function getTweetContent(url: string): Promise<{ text: string; error?: string }> {
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
          return JSON.stringify({
            author: author,
            time: time,
            content: texts.join('\\n\\n'),
            replies: reply ? reply.getAttribute('aria-label') : '',
            retweets: retweet ? retweet.getAttribute('aria-label') : '',
            likes: like ? like.getAttribute('aria-label') : '',
          });
        })()`,
      });

      const parsed = JSON.parse((result as any).value);
      if (!parsed) return { text: "", error: "未找到推文内容" };

      return {
        text: [
          "## " + parsed.author,
          "📅 " + parsed.time,
          "",
          parsed.content,
          "",
          "---",
          "💬 " + parsed.replies + "  🔁 " + parsed.retweets + "  ❤️ " + parsed.likes,
        ].join("\n"),
      };
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
      description: "获取推文完整内容。连接已登录 X 的浏览器，展开'显示更多'，提取作者、时间、全文。返回 Markdown。",
      inputSchema: {
        type: "object" as const,
        properties: { url: { type: "string" as const, description: "推文 URL" } },
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === "get_tweet") {
    const url = args?.url as string;
    if (!url) return { content: [{ type: "text", text: "Error: url is required" }] };
    const r = await getTweetContent(url);
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
    console.error("  get-tweet <url>        获取推文完整内容");
    console.error("  get-timeline [count]   获取首页推文列表");
    console.error("  get-article <url>      获取文章完整内容");
    process.exit(command ? 0 : 1);
  }
  if (command === "get-tweet") {
    if (!arg) { console.error("Error: url is required"); process.exit(1); }
    const r = await getTweetContent(arg);
    console.log(r.error ? "Error: " + r.error : r.text);
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
