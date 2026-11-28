# issue #67（续）：「ChatGPT 登录」提供商 —— Sign in with ChatGPT 官方开源接入

issue #67 原始诉求落地：在「设置 → AI 配置 → 模型提供商」新增 **「ChatGPT 登录（订阅额度）」**
（protocol `chatgpt`）。工作台自己完成官方 **Sign in with ChatGPT 开源接入流程**——
OAuth PKCE 授权（无 client secret / partner key）后，用 ChatGPT 订阅额度直连官方
**Responses API**（`https://api.openai.com/v1/responses`），不经过任何第三方 CLI/中转。

## 一、官方契约（2026-11 核实）

- **动态客户端注册**：authorize 以 `client_id=dynamic_agent_client` +
  `agent_name_hint=<应用名>` + `ext_agent_host_id=<安装标识>` 发起，OpenAI 签发专属
  client_id 并**经回调 query 带回**；后续 token/刷新/撤销都用签发的 id。
- **授权**：`GET https://auth.openai.com/api/accounts/authorize`，scope
  `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`，
  PKCE S256，redirect_uri 是 `127.0.0.1` 回环**临时端口**（服务端起一次性 HTTP 服务器），
  state 归属校验 + nonce 防重放，verifier 只留在服务端内存。
- **token**：`POST https://auth.openai.com/api/accounts/oauth/token`（form-urlencoded，
  `resource=https://api.openai.com/v1`）；access_token ~1h、refresh_token ~30d
  **轮换**（一次一用，刷新后必须立即落库）；terminal 刷新错误
  （`invalid_grant` / `refresh_token_*` 等）= 必须重新登录。
- **身份验证**：token 响应的 id_token 必须验签（RS256/JWKS， issuer/aud/exp/sub/nonce）。
- **推理**：`POST /v1/responses`，Bearer access_token；预览期硬约束
  `store:false + stream:true + input 数组`，禁用 `temperature/top_p/max_output_tokens/
  metadata/previous_response_id` 等字段，system 走 `instructions`，function/custom
  工具必须收进带描述的 `namespace`；订阅额度用尽是流内失败
  （`subscription_sharing_usage_limit_exceeded`）。
- **套餐模型目录**：`GET /v1/models` 返回 `{models:[{slug,display_name,visibility}]}`，
  取 `visibility==='list'` 的 slug。

实现与 `LinguaGacha`（TS）/ `shelley`（Go）/ `openchatx-mcp`（TS）三个独立开源实现
交叉验证一致。

## 二、工作台实现

- **`server/src/ai/chatgptAuth.ts`**：OAuth 全流程（回环回调服务器、PKCE、code 交换、
  id_token 验签（node:crypto 实现，零新依赖）、刷新串行化 + 轮换落库、撤销、套餐模型目录）。
  凭据以 **AES-256-GCM 加密**存 settings 表（密钥在 `<dataDir>/ai-chatgpt-auth.key`，
  独立于 DB/每日备份——token 不沿用 apiKey 的明文级别，issue67 复核结论）。
- **`server/src/ai/chatgptProvider.ts`**：Responses API 适配器。`ChatMessage`/`ChatOptions`
  抽象不变，AiProvider 按 protocol 分派——聊天/标题/摘要/计划/题单等调用点零改动；
  工具往返循环可用（function_call ⇄ tool_calls 映射）；temperature/maxTokens 在本路径
  静默不生效（预览期禁用，跟随模型默认）。
- **登录交互**：设置页点「使用 ChatGPT 账号登录」→ `POST /api/settings/ai/chatgpt/login`
  → 前端用系统浏览器打开授权 URL → `GET /ai/chatgpt/login/poll` 轮询结果 → 成功后套餐
  模型自动写入该提供商的模型目录并选用首个模型。「退出登录」调官方撤销端点 + 本地清除。
- **凭据刷新**：请求前临期（<5min）自动刷新；401 强制刷新一次重试；全局串行化防止
  并发刷新互相作废；terminal 失效清除凭据并提示重新登录。
- **设置页**（AiSettingsCard）：chatgpt 提供商隐藏 API 密钥输入，显示登录态/邮箱标签、
  登录/退出按钮；模型目录照常工作（登录后由套餐目录填充）。

## 三、与「本地 Codex」的关系

两条路线并存（issue #67 评论区的两个提议）：`protocol='chatgpt'` 走官方 OAuth 直连，
`protocol='codex'` 走本机 Codex CLI 子进程（登录态由 Codex 自管）。都不依赖第三方
API Key，可随时用「当前使用」下拉切换。

## 四、测试

- `server/test/chatgpt-provider.test.ts`：预览期约束（store/stream/禁用字段/instructions/
  developer 角色/namespace 工具）、SSE 事件解析（delta/reasoning/function_call/usage）、
  额度错误友好化、临期刷新与 401 重试、多模态映射。
- `server/test/settings-ai.test.ts`：OAuth 登录端到端（fake 授权服务器 + 真 RSA/JWKS 验签，
  校验授权 URL 契约参数、凭据密文落库、套餐模型写入目录、刷新轮换立即落库、登出撤销）。
