# openclaw-mcp-twitter-reader

通过已登录的浏览器获取 X (Twitter) 推文全文、配图和外部文章内容。

支持 **MCP 协议**（给 AI 客户端）和 **CLI 模式**（命令行直接调用）。

## 安装

```bash
npm install
```

## CLI 模式

```bash
# 获取推文全文（含引用推文）
npx tsx src/index.ts get-tweet "https://x.com/user/status/123456"

# 获取推文 + 下载引用长文中的配图（自动定位图片在文章中的位置）
HTTPS_PROXY=http://proxy:port npx tsx src/index.ts get-tweet "https://x.com/user/status/123456" --images --dir ./images

# 获取首页推文列表（默认 10 条）
npx tsx src/index.ts get-timeline 5

# 获取外部文章全文（Readability 提取 + Markdown）
npx tsx src/index.ts get-article "https://example.com/blog/post"

# 下载推文配图到本地（排除头像，只保存媒体图片原图）
HTTPS_PROXY=http://proxy:port npx tsx src/index.ts download-images "https://x.com/user/status/123456" ./my-images/
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CDP_URL` | `http://localhost:18800` | Chrome DevTools 协议地址 |
| `HTTPS_PROXY` / `HTTP_PROXY` | - | 代理（下载 pbs.twimg.com 图片需要） |

## MCP 模式

在 MCP 客户端配置中添加：

```json
{
  "mcpServers": {
    "twitter-reader": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/path/to/openclaw-mcp-twitter-reader",
      "env": {
        "CDP_URL": "http://localhost:18800",
        "HTTPS_PROXY": "http://proxy:port"
      }
    }
  }
}
```

### 工具列表

| 工具 | 参数 | 说明 |
|------|------|------|
| `get_tweet` | `url`, `include_images?`, `output_dir?` | 获取推文完整内容。`include_images=true` 时自动提取引用长文并生成带图片引用的 Markdown |
| `get_timeline` | `count?` | 获取推荐首页推文列表 |
| `get_article` | `url` | 获取外部文章全文（Readability + Markdown） |
| `download_tweet_images` | `url`, `output_dir?` | 下载推文配图到本地（排除头像，原图 large 格式） |

## 开发踩坑记录

### CDP evaluate 返回值结构

`client.Runtime.evaluate()` 返回 `{ result: { type, value, description } }`。

```js
// ✅ 正确
const { result } = await client.Runtime.evaluate({ expression: '...' });
const value = result.value;  // 注意：result 已经是 { type, value }

// ❌ 错误（多了一层）
const value = result.result.value;  // undefined!
```

### X 引用推文卡片没有 href

X 的引用推文卡片（embedded tweet card）使用 `role="link"` 的 div，但 `getAttribute('href')` 返回空字符串。导航靠 JavaScript 点击事件。

**解决**：通过用户名差异检测引用推文——扫描主推文内所有 `role="link"` 的 div，找包含不同 `@handle` 的那个。

### X 长文 article 不使用 tweetText

普通推文内容在 `[data-testid="tweetText"]`，但 X 的长文 article（Twitter Articles）使用 `h1/h2/h3` 标题结构，`tweetText` 为空。

**解决**：检测 `tweetText` 总长度 < 50 且有 ≥2 个 `h1` → 判定为长文。长文内容用 `article.textContent` 或 TreeWalker 提取。

### TreeWalker 提取带图片位置的结构化内容

直接遍历 DOM 子元素找不到图片——X 的图片被深层嵌套在 div 里，子元素遍历无法穿透。

**解决**：用 `document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)` 按文档顺序遍历所有元素节点，遇到 `img[src*="pbs.twimg.com/media/"]` 时记录位置。这样能精确还原图片在文章中的位置。

### pbs.twimg.com 图片下载

三种方式都失败了：
- `Canvas.toDataURL()` → Tainted canvas（跨域图片）
- 浏览器内 `fetch()` → CORS 阻止（X 的 CSP）
- `FileReader.readAsDataURL(blob)` → blob 也是空的

**解决**：pbs.twimg.com 的图片 URL 不需要 cookies，直接从 Node.js 端 fetch 下载。通过 `undici` 的 `ProxyAgent` 走代理。

### Node.js 原生 fetch 不支持代理

Node 22 的 `globalThis.fetch` 不读 `HTTPS_PROXY` 环境变量。

**解决**：用 `undici` 的 `ProxyAgent` + `fetch`：

```js
import { ProxyAgent, fetch as undiciFetch } from "undici";
const dispatcher = new ProxyAgent(process.env.HTTPS_PROXY);
const res = await undiciFetch(url, { dispatcher });
```

### 变量作用域陷阱

`let downloadedImages = []` 定义在 `if (quotedHandle)` 块内，但 `return { images: downloadedImages }` 在 `if` 块外。当没有引用推文时，运行时报 `ReferenceError: downloadedImages is not defined`。

**解决**：将变量声明提升到 `withCdp` 回调的顶层作用域。

### X 页面加载不稳定

导航到推文 URL 后，有时 5 秒内 DOM 没加载完（返回 0 个 `article`）。

**解决**：加重试循环——最多等 3 轮，每轮 3 秒，直到 `article` 出现。

## 原理

- 通过 CDP (Chrome DevTools Protocol) 连接已登录 X 的浏览器（OpenClaw 内置隔离浏览器）
- `chrome-remote-interface` 直接操作页面 DOM
- 文章提取优先 HTTP 抓取 + Readability，失败降级到浏览器提取
- 图片下载走 Node.js + undici 代理（pbs.twimg.com 不需要登录态）

## License

MIT
