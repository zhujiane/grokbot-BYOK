# Docker API 与 Windows Grok Bot 登录态导入

## 支持范围

这里的 Grok Bot 是 Windows/macOS/Linux 桌面应用，用户数据在 `%APPDATA%\Grok Bot` 等目录；不是 Grok Build/CLI 的 `~/.grok/auth.json`，也不是 grok.com 网页 SSO。

现在支持导入桌面端已保存的**云电脑网关凭证**，通过 API 列出 Bot、向现有 Bot 提交任务、读取任务线程和最近记录。无需新做登录流程，无需 xAI API Key。

视频与聊天现已增加 **Bot 任务适配器**，详情见 [完整请求、参数和返回格式](desktop-api.md)。每个请求会创建独立 Bot，并使用该 Bot 已有工具执行；它不等同于原始模型推理 API。

| 能力 | 凭证 | 接口 |
|---|---|---|
| Bot 管理与记录 | 桌面导出 gateway session | `/v1/bots*` |
| Bot 文本任务，OpenAI 风格 JSON/SSE | 同上 | `/v1/chat/completions`，模型 `grok-bot` |
| Bot GenerateVideo 任务，OpenAI/xAI 风格 | 同上 | `/v1/videos*`，模型 `grok-bot-video` |
| BYOK 原始聊天推理 | 另行配置 provider Key | `/v1/chat/completions`，配置的模型 |
| 官方 xAI 视频后端，可选 | xAI 官方 Key | `/v1/videos*`，与桌面视频后端二选一 |

安装包 0.77.0 的协议已核对，且 2026-10-28 已用桌面凭证真实生成并下载视频（4.042 秒、1280×720、4,541,524 字节）。支持认证下载和 15 分钟临时签名链接，见 [API 说明](desktop-api.md)。按当前需求，默认关闭聊天。视频直接附件解析现要求用新版导出脚本增加 `--include-backend`，补导账户访问令牌；已关闭追加 Bot 对话恢复。新账户凭证已导入，附件解析接口认证通过；旧视频返回 `NOT_IN_STORE`，没有存储直链，本服务下载已再次验证。新任务在同一次生成请求中指定 `/tmp/` 输出并要求返回路径，不追加 Bot 对话。

## 在 Windows 导出

需要 Windows 上已登录 Grok Bot，并已成功连接其云电脑；使用同一 Windows 账户运行 Node.js 22+。不需要管理员权限或创建新登录。

把仓库的 `scripts/export-grok-bot-session.cjs` 复制到 Windows：

```powershell
node .\export-grok-bot-session.cjs --inspect
node .\export-grok-bot-session.cjs --include-backend --output "$env:USERPROFILE\grok-bot-session-with-backend.json"
```

`--inspect` 只输出路径、文件是否存在、版本、条目键和字段类型，不输出任何令牌。支持旧版单条目，以及 version 2/3 中 `entries[key].encrypted` 为字符串的结构；新版内部字段不同时会拒绝导出，不猜测内容。多条目必须用 `--entry ENTRY_KEY` 明确选择。

脚本在本机用 Windows DPAPI 解开 Electron Safe Storage 密钥，再验证 AES-GCM 密文，输出以下格式。真正的令牌不要粘贴到聊天里：

```json
{
  "version": 1,
  "gatewayUrl": "https://your-box.cursorvm.com",
  "gatewayToken": "PRIVATE",
  "headers": {"x-anyrun-network-token": "PRIVATE"},
  "backend": {"baseUrl":"https://api2.cursor.sh","accessToken":"PRIVATE","clientVersion":"0.77.0"},
  "exportedAt": "2026-10-27T00:00:00.000Z"
}
```

导出格式的 `version: 1` 与桌面端加密存储文件的 version 3 不冲突。脚本保留网关凭证，以及 `--include-backend` 要求的桌面账户 access token 和必要元信息，不读取密码、浏览器 Cookie、CLI 登录或刷新令牌；不修改原桌面文件。

存储格式参考 [grok-bot-cli 的 app-session 实现](https://github.com/ScriptedAlchemy/grok-bot-cli/blob/main/src/core/app-session.js)，Windows Safe Storage 解密过程及实际桌面版本需由本机导出结果验证。导出成功不会自动刷新登录态；凭证失效时重新打开桌面端并导出。

## Docker 部署

本次服务器部署实例：`http://172.26.115.39:8789`，容器 `grokbot-byok-api-1`。真实桌面凭证已验证能列出 3 个 Bot；API 访问令牌保存在宿主 `.env` 的 `API_TOKEN`，接入配置文件保存在被 Git 忽略的 `secrets/api-client.json`。默认 `/v1/models` 仅列出 `grok-bot-video` 视频任务适配器；它不是底层模型权益目录。

私下把导出文件传到服务器，放在 `secrets/grok-bot-session.json`。不要提交到 Git；`secrets/` 和导出文件名已加入忽略列表，Docker 构建上下文也排除了凭证。

运行容器的 UID 为 1000。Linux 服务器上设置权限：

```bash
mkdir -p secrets
sudo chown 1000:1000 secrets secrets/grok-bot-session.json
sudo chmod 700 secrets
sudo chmod 600 secrets/grok-bot-session.json
```

在 `.env` 设置调用方 API 令牌及端口（与上游网关令牌独立）：

```dotenv
API_TOKEN=你设置的长随机令牌
API_BIND_ADDRESS=127.0.0.1
API_PORT=8789
```

希望局域网可访问时，把 `API_BIND_ADDRESS` 改成服务器局域网地址。对公网服务应通过 HTTPS 反向代理。

```bash
docker compose up -d --build
docker compose ps
```

镜像直接运行服务，**不会执行 setup、修改 Grok Bot 的 host 文件、启动桌面应用或登录**。Compose 挂载凭证目录为只读，容器使用非 root 用户；更新导出文件后不需重建镜像或重启。健康检查只确认服务存活，不代表上游凭证有效。

默认部署配置在 `config/docker.example.json`：启用 REST、Bot 视频任务适配，关闭聊天任务适配，关闭旧 Connect 入口和官方 xAI 视频后端，不配置 BYOK 模型。需要自定义时，在 Compose 中只读挂载自己的配置文件到 `/app/config/config.json`，并显式把它引用的环境变量传给容器；单独修改宿主 `.env` 不会自动把任意变量传进容器。

## API 调用

除 `/healthz` 外，下列 REST 接口均使用：

```http
Authorization: Bearer <API_TOKEN>
```

以下命令假设你已在终端设置 `API_TOKEN`：

```bash
BASE_URL=http://127.0.0.1:8789

# 服务是否运行
curl -sS "$BASE_URL/healthz"

# 是否已导入凭证及当前进程是否成功调用过网关（不返回任何凭证）
curl -sS "$BASE_URL/v1/auth/status" -H "Authorization: Bearer $API_TOKEN"

# 列出配置的模型路由
curl -sS "$BASE_URL/v1/models" -H "Authorization: Bearer $API_TOKEN"

# 列出桌面账户的 Bots
curl -sS "$BASE_URL/v1/bots" -H "Authorization: Bearer $API_TOKEN"
```

`/v1/models` 遵循 OpenAI 的 `object: "list", data: [...]` 结构，附加 `catalog_source` 字段。它列出已配置的任务适配器、带凭证的 BYOK 模型和显式开启的官方视频模型；**不是桌面账户的底层模型权益目录**。默认 Docker 仅列出 `grok-bot-video`，`owned_by` 为 `grok-bot-task-adapter`。

`/v1/bots` 原样返回网关 Bot 列表，当前实测是数组；每项含 `id`、`name`、运行状态等，用户内容可能在列表预览字段中，注意保管 API 令牌。

### 给 Bot 提交任务

从 `/v1/bots` 取真实 ID：

```bash
BOT_ID=真实Bot的ID
curl -sS "$BASE_URL/v1/bots/$BOT_ID/messages" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"请生成一段橘猫在樱花树下散步的视频，完成后给出文件或下载链接。"}'
```

参数：

| 字段 | 类型 | 说明 |
|---|---|---|
| `prompt` | string | 必填，最多 32000 字符 |
| `clientNonce` | UUID string | 可选，用于关联提交；省略则自动生成，不保证上游幂等 |
| `replyToId` | string | 可选，回复某个已有消息 |

返回 HTTP 202，示意：

```json
{
  "agentId": "bot-id",
  "clientNonce": "7f691214-01a3-47d8-8ca3-6ce15b18a261",
  "delivery": "accepted",
  "result": {"messageId":"upstream-message-id"}
}
```

`result` 原样保留网关响应；部分版本返回 `accepted: true`，部分返回 `messageId`。没有确认回执时 `delivery` 为 `unknown`。HTTP 202 表示已提交，不代表任务或视频已完成。

### 查询接收状态、线程和结果

```bash
# 用提交返回的 clientNonce 查询接收状态
curl -sS "$BASE_URL/v1/bots/$BOT_ID/acceptance?account_slot=桌面账户槽位&client_nonce=真实UUID" \
  -H "Authorization: Bearer $API_TOKEN"

# 最近记录，limit 取 1–200，默认 40
curl -sS "$BASE_URL/v1/bots/$BOT_ID/transcript?limit=40" \
  -H "Authorization: Bearer $API_TOKEN"

# 已知消息/线程根 ID 时读取完整线程
curl -sS "$BASE_URL/v1/bots/$BOT_ID/thread?root_id=真实线程根ID" \
  -H "Authorization: Bearer $API_TOKEN"
```

查询结果原样返回桌面网关结构。`account_slot` 是安装包协议要求的账户槽位；最小网关导出没有包含它，不能仅凭 Bot ID 和 nonce 查询接收状态，可直接用 transcript 追踪。任务适配器通过回显 nonce 与 lastTurnSettlement 关联完成状态，不依赖该参数。

### 原项目的 BYOK Chat Completions

自定义 Docker 配置的 `providers` 后可调用：

```bash
curl -sS "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"你配置的模型ID","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

`stream:true` 返回上游 OpenAI SSE；`false` 返回上游 JSON。REST 入口按 provider 优先级选择第一个配置匹配项并复用兼容处理和 key 轮换，**没有复用旧 Connect 链路的完整重试、断路器、故障切换、会话亲和和性能调度**。桌面 gatewayToken 不会被发送给 BYOK provider。

## 失败处理

- 401：调用方 `API_TOKEN` 不匹配。
- 400/415/413：参数、Content-Type 或请求体大小错误。
- 403：默认 Docker 配置禁止旧 Connect 路由。
- 404：接口或配置的模型不存在。
- 503：未导入凭证、凭证格式错误、网关返回 401/403，或 HTTP 417 休眠。先打开桌面唤醒，必要时重新导出。
- 429/502：上游限流或网关错误。
- 504：请求超时；任务可能已被接收，先查接收状态/记录，不自动重发。

Bot 请求每次重新读取凭证文件。宿主机文件所有者/权限要允许容器 UID 1000 读取。不要把整个 Windows 用户目录、整个 `%APPDATA%` 或 `Local State` 挂进 Linux；只需最小化导出文件。
