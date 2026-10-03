# dsh-web-search-firecrawl

[English](README.en.md) | 中文

给 DeepSeek Harness 的 web 能力 seam（`ctx.web`）用的 **Firecrawl 搜索提供方**，注册 id 为
`firecrawl`。

## 为什么需要它

Harness 自带的搜索提供方只有一个：`@deepseek-ai/dsh-web-search-deepseek`。它把搜索实现成一次
Anthropic 兼容的 Messages 调用（`POST {baseURL}/messages`，配合原生 `web_search_20250305`
服务端工具）——也就是说，**它只会说 Anthropic Messages 协议**。

Firecrawl 是独立的检索 API（`POST {baseURL}/search`），没有 `/messages` 路由，因此把
`web-search-deepseek.baseURL` 指向 `https://api.firecrawl.dev` 只会得到
`HTTP 404: POST /messages is not a Firecrawl API endpoint`。本插件补上缺失的那一半：一个真正调用
Firecrawl `/search` 的搜索提供方。

相比 DeepSeek 原生搜索，本插件是**专用检索端点**：一次 HTTP 往返、结构化结果，不消耗额外的模型
轮次与生成 token。

## 配置

```yaml
# 选中 Firecrawl 提供方。deepseek-official 仍然注册（其设置页照旧可用）但不再被选中，
# 否则两个可用提供方会让 seam 抛 WEB_PROVIDER_AMBIGUOUS。
# 注意：patch 的 config 是整体替换而不是深合并，所以 fetchProvider 必须一并写出。
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: firecrawl
    fetchProvider: http

# 新增条目必须走 insert：以未知 id 为目标的非 insert 补丁会被 loader 警告并跳过。
- insert:
    - id: web-search-firecrawl
      name: dsh-web-search-firecrawl
      config:
        apiKeyEnv: FIRECRAWL_API_KEY
        baseURL: https://api.firecrawl.dev/v1
        maxResults: 5
        timeoutMs: 30000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 未设置 | Firecrawl 密钥字面值；非空时优先于 `apiKeyEnv`（密钥不宜进配置文件，一般别用） |
| `apiKeyEnv` | `FIRECRAWL_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用；没有该服务时回退到进程环境变量 |
| `baseURL` | `https://api.firecrawl.dev/v1` | Firecrawl API 基址；追加 `/search`（末尾斜杠会被忽略） |
| `maxResults` | `5` | seam 未传 `maxResults` 时请求的结果数；1–100 |
| `timeoutMs` | `20000` | 单次搜索墙钟上限（毫秒） |

## 行为

- `search()` 把 seam 的 `maxResults` 直接当作 Firecrawl 的 `limit`（因此不会超额抓取）；seam 未传时用
  配置里的 `maxResults`，并夹在 1–100。
- 响应映射：`data[]`（v1 扁平形状）与 `data.web[]`（分组形状）都接受；按 `url` 去重；`title` 取同名
  字段；`snippet` 取 `description`（或 `snippet`），超过 1200 字符截断；`publishedAt` 仅在 Firecrawl
  提供 `date` / `publishedDate` / `metadata.publishedTime` 时出现。
- 错误码沿用 seam 词汇：缺凭据 `WEB_PROVIDER_CREDENTIAL_MISSING`、调用方取消 `WEB_ABORTED`，
  其余（HTTP 非 2xx、超时、响应不可解析、`success:false`）为 `WEB_PROVIDER_ERROR`，且消息始终带上
  实际使用的端点与恢复指引。
- 重定向按 `redirect: "error"` 拒绝；每次操作只快照一次配置，一次搜索不会混用两代设置。

## 安装

1. 插件源码放到 `<profile>/plugins/dsh-web-search-firecrawl`。
2. 在 `<profile>/node_modules` 下建同名链接指向它（pnpm 的 `file:` 依赖布局）。
3. 在 profile 的 `package.json` 里声明依赖：`"dsh-web-search-firecrawl": "file:./plugins/dsh-web-search-firecrawl"`。
   profile 的直接依赖是运行时解析表的依据，不声明则 loader 无法按包名导入。
4. 在 profile 的 `cordis.patch.yml` 里加上面的 `insert` 条目与 `web` 覆盖。
5. 保存后即热生效（本机已实测：无需重启 DSH Desktop）。

仓库内的 `install-firecrawl-provider.ps1` 会完成 1–4，并自带备份、回滚与结构自校验。

## 自测

```bash
FIRECRAWL_API_KEY=fc-... node test/offline.mjs
# 或从 `KEY: value` 凭据文件里读（本机 DSH 的密钥就存在这种文件里）：
node test/offline.mjs --var FIRECRAWL_API_KEY --credentials ~/.dsh/.credentials.yaml
```

覆盖：模块面、端点拼接、两种响应形状、去重与 snippet 截断、`maxResults` 生效、真实 Firecrawl 检索，
以及缺凭据 / 密钥被拒 / 端点不可达 / 调用方取消 / 超时五条失败路径。没有密钥时**现场那几条断言会
跳过**（仍以 0 退出），因此它同时可以当冒烟测试用。

测试运行在本机已装的 harness 上：`@deepseek-ai/schemastery` 从 harness 安装解析，本插件 import 的
另外两个 seam（`dsh-web`、`dsh-credentials`）由测试内部打桩。

## 已知限制

- 只取 Firecrawl 的 web 结果，不请求 news / image 等其它来源。
- `description` 是 Firecrawl 给的摘要而非引用片段；未提供 `description` 的结果没有 `snippet`。
- 与 `web-search-deepseek` 同时注册时必须二选一（`web.searchProvider`），否则 seam 抛
  `WEB_PROVIDER_AMBIGUOUS`。

## 许可

MIT
