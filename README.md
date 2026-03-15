# mcp-twitter-reader

通过已登录的浏览器获取 X (Twitter) 推文全文和外部文章内容。

支持 **MCP 协议**（给 AI 客户端）和 **CLI 模式**（命令行直接调用）。

## 安装

```bash
npm install
```

## CLI 模式

```bash
# 获取推文全文
npx tsx src/index.ts get-tweet "https://x.com/user/status/123456"

# 获取首页推文列表（默认 10 条）
npx tsx src/index.ts get-timeline 5

# 获取外部文章全文（Readability 提取 + Markdown）
npx tsx src/index.ts get-article "https://example.com/blog/post"
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CDP_URL` | `http://localhost:18800` | Chrome DevTools 协议地址 |

## MCP 模式

在 MCP 客户端配置中添加：

```json
{
  "mcpServers": {
    "twitter-reader": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "/path/to/mcp-twitter-reader",
      "env": {
        "CDP_URL": "http://localhost:18800"
      }
    }
  }
}
```

### 工具列表

| 工具 | 参数 | 说明 |
|------|------|------|
| `get_tweet` | `url` | 获取推文完整内容（自动展开"显示更多"） |
| `get_timeline` | `count?` | 获取推荐首页推文列表 |
| `get_article` | `url` | 获取外部文章全文（Readability + Markdown） |

## 原理

- 通过 CDP (Chrome DevTools Protocol) 连接已登录 X 的浏览器
- `chrome-remote-interface` 直接操作页面 DOM
- 文章提取优先 HTTP 抓取 + Readability，失败降级到浏览器提取

## License

MIT
