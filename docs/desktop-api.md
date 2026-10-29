# 使用 Grok Bot 桌面登录态的 API

Docker 默认后端使用导入的桌面网关凭证，不需要 `XAI_API_KEY`，也不读取 `~/.grok/auth.json`。导出与部署步骤见 [部署说明](grok-bot-deployment.md)。服务器实例为 `http://172.26.115.39:8789`，客户端接入配置保存在宿主 `secrets/api-client.json`，其中包含 `base_url` 和 `api_key`，不提交 Git。

**验证状态（2026-10-28）：**已用导入的桌面凭证真实创建 Bot、生成视频、查询完成并通过 API 下载 MP4：4,541,524 字节，解析时长 4.042 秒、画面 1280×720。SHA-256 为 `429a17f88372ac91eb0e51daafadc8db185ad07f9794227aaedb3cb46ae4c47f`。**下载链路修订：**已停止追加 Bot 对话/复制恢复，改为桌面账户后端 `ResolveGrokBotAttachmentReads` 直接解析签名 URL。新导出的账户凭证已导入，账户附件接口认证通过（HTTP 200），但该旧视频附件返回 `NOT_IN_STORE`，未提供存储签名 URL；桌面唤醒后，现有视频通过服务下载再次验证成功。上面的实测文件来自此前复制恢复链路。新请求已要求 GenerateVideo 直接写入独立 `/tmp/` 路径，并在同一次请求中返回结构化路径，无需追加对话复制；此新输出要求已自动测试，尚未再次真实生成验证。

本次上游 transcript 未公开 GenerateVideo 工具记录，因此真实结果 `generation_tool_verified:false`，不据此声称核验了底层生成模型。按当前需求，Docker 默认关闭聊天适配器，只暴露视频模型。

## 基础请求

所有 `/v1/*` 请求均携带客户端 API 令牌：

```http
Authorization: Bearer <API_TOKEN>
```

这个令牌来自服务端 `.env` 的 `API_TOKEN`，不使用 Windows 导出文件中的 `gatewayToken`。后者由服务器内部读取。

```bash
BASE_URL=http://172.26.115.39:8789
# 从私有接入配置读取；也可以自行设置 API_TOKEN
export API_TOKEN="$(python3 -c 'import json; print(json.load(open("secrets/api-client.json"))["api_key"])')"
curl -sS "$BASE_URL/v1/models" -H "Authorization: Bearer $API_TOKEN"
```

默认模型列表返回：

```json
{
  "object": "list",
  "data": [
    {"id":"grok-bot-video","object":"model","created":0,"owned_by":"grok-bot-task-adapter"}
  ],
  "catalog_source": "configured_providers_and_bot_task_adapters",
  "grok_bot_model_catalog_available": false
}
```

这个 ID 表示任务适配器，底层模型由 Grok Bot 决定。模型列表列出配置的入口，不探测上游当前是否在线。

## OpenAI 风格视频创建

```bash
curl -sS "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"grok-bot-video",
    "prompt":"一只橘猫在樱花树下散步，镜头缓缓推进，电影质感",
    "seconds":"8",
    "size":"1280x720"
  }'
```

| 字段 | 类型 | 必填/默认 | 说明 |
|---|---|---|---|
| `model` | string | 默认 `grok-bot-video` | 只接受此桌面视频适配器 ID |
| `prompt` | string | 必填 | 去除首尾空白后 1–32000 字符 |
| `seconds` | string | 默认 `"4"` | `"4"`、`"8"`、`"12"` |
| `size` | string | 默认 `1280x720` | `1280x720` 或 `720x1280`；提交 720p 和对应宽高比 |
| `input_reference` | object | 可选 | `{ "image_url": "https://.../image.png" }` 或 PNG/JPEG/WebP base64 data URL |
| `reference_images` | array | 可选 | 1–8 个 `{ "url": "HTTPS 或图片 data URL" }`，映射为 `reference_image_paths` |
| `last_frame` | object | 可选 | `{ "url": "HTTPS 或图片 data URL" }`，映射为 `last_frame_path` |
| `keyframes` | array | 可选 | 1–16 个 `{ "url": "HTTPS 或图片 data URL", "timestamp_seconds": 2 }`；时间唯一且位于 0 到请求时长，自动排序 |

以上三个新字段为本项目扩展，也适用于 xAI 风格入口；多图请求使用 JSON。Base64 图片逐张上传，HTTPS 图片要求 Bot 在首次任务内下载，再把本地路径传给工具。数量限制由适配器设置；参数映射已自动测试，上游多图/首尾帧/关键帧生成尚未实测。所有图片要求一次提交，不追加 Bot 对话，也不要求将参考图拼接或静默忽略参数。

只接受列出的字段；未知字段返回 400。JSON/multipart 请求上限 20 MiB。HTTPS 图片由 Bot 下载到自己的电脑后使用；base64/上传文件经认证网关上传。服务本身不直接下载用户提供的外部图片 URL。

OpenAI SDK 常用的 multipart 上传方式也支持：

```bash
curl -sS "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_TOKEN" \
  -F model=grok-bot-video \
  -F 'prompt=让图片里的猫缓慢走向镜头' \
  -F seconds=4 \
  -F size=1280x720 \
  -F 'input_reference=@./cat.png;type=image/png'
```

创建返回 HTTP 200，立即给出本地任务凭证，示例：

```json
{
  "id":"video_12345678-1234-4123-8123-123456789abc",
  "object":"video",
  "model":"grok-bot-video",
  "prompt":"一只橘猫在樱花树下散步，镜头缓缓推进，电影质感",
  "created_at":1793102400,
  "seconds":"8",
  "size":"1280x720",
  "status":"queued",
  "progress":0,
  "backend":"grok_bot_task",
  "error":null,
  "generation_tool_verified":false,
  "requested_parameters":{"duration":8,"aspect_ratio":"16:9","resolution":"720p"}
}
```

服务器为该任务创建独立 Bot，并要求内置 `GenerateVideo` 工具直接写入 `/tmp/grokbot-{video_id}.mp4`，发送 MP4 附件及实际路径的 JSON；`agent_id`、`delivery` 会在后续查询中出现。`delivery: accepted` 只代表任务被接收。参数作为工具要求提交，返回的 `seconds`、`size`、`requested_parameters` 是请求值，不能当作生成文件的实测时长或分辨率。

## 查询和下载

```bash
VIDEO_ID=创建返回的video_ID
curl -sS "$BASE_URL/v1/videos/$VIDEO_ID" \
  -H "Authorization: Bearer $API_TOKEN"
```

`status` 为 `queued`、`in_progress`、`completed` 或 `failed`。没有上游进度百分比时保持 0，完成后为 100。建议每 2–5 秒查询一次。

完成示例（保留其他创建字段）：

```json
{
  "id":"video_12345678-1234-4123-8123-123456789abc",
  "object":"video",
  "model":"grok-bot-video",
  "status":"completed",
  "progress":100,
  "backend":"grok_bot_task",
  "agent_id":"实际BotID",
  "delivery":"accepted",
  "generation_tool_verified":true,
  "error":null,
  "video":{"url":"/v1/videos/video_12345678-1234-4123-8123-123456789abc/content"}
}
```

完成要求：独立 Bot 发出的 MP4 附件或受约束的 `/tmp/` 结构化输出路径，能通过网关读取，并验证 MIME、文件长度与 MP4 文件头。任务通过用户消息中的 clientNonce → requestId 关联；工具记录不可见时，`generation_tool_verified` 保持 false。附件别名使用桌面账户的 `ResolveGrokBotAttachmentReads` 解析签名 URL，从存储服务直接读取；不再向 Bot 追加消息，不要求复制文件。账户访问令牌缺失时返回 503 `desktop_backend_session_missing`，路径不存在时返回 502 `attachment_unavailable`，不会自动改走对话恢复。用户输入附件、工具摘要、单纯的“生成成功”不会作为完成依据。

```bash
curl --fail-with-body "$BASE_URL/v1/videos/$VIDEO_ID/content" \
  -H "Authorization: Bearer $API_TOKEN" \
  -o result.mp4
```

成功为 `Content-Type: video/mp4` 的二进制文件，支持单个 HTTP `Range: bytes=起点-终点`、开区间和后缀区间，返回 206；非法区间返回 416。未完成返回 409。只支持 `variant=video`，不提供缩略图或 spritesheet。

### 直接获取桌面原始签名 URL

新版 Windows 导出脚本可同时导出网关凭证与当前桌面账户的 access token，不导出 refresh token，也不创建登录流程：

```powershell
node .\export-grok-bot-session.cjs --include-backend --output "$env:USERPROFILE\grok-bot-session-with-backend.json"
```

将新文件私下传到服务器，替换 `secrets/grok-bot-session.json`；服务每次请求重读，无需重启。不要把令牌粘贴到聊天里。账户令牌过期后，从已登录桌面重新导出。

```bash
curl -sS "$BASE_URL/v1/videos/$VIDEO_ID/source-url" \
  -H "Authorization: Bearer $API_TOKEN"
```

返回示例：

```json
{"url":"https://存储服务/视频对象?签名参数","expires_at":1793148000,"size":4541524,"content_type":"video/mp4"}
```

这是存储服务给出的原始签名地址，过期时间由上游决定，无需再联系 Bot。服务对 `/content` 的读取也优先采用此链路，不向存储服务发送桌面账户令牌。账户凭证已实测通过认证；旧视频返回 `NOT_IN_STORE`，因此 `/source-url` 返回 HTTP 404、`source_url_unavailable`。并非所有桌面可播放附件都有存储直链；此时可对可读取的生成文件使用 `/content` 或 `/download-url`。真实 STORE 签名地址下载分支尚未遇到可验证样本，Range 与过期重取已通过模拟测试。

### 本服务临时下载链接

需要浏览器直接下载时，先用 API Key 获取 15 分钟有效的签名链接：

```bash
curl -sS "$BASE_URL/v1/videos/$VIDEO_ID/download-url" \
  -H "Authorization: Bearer $API_TOKEN"
```

```json
{"url":"/v1/videos/video_.../content?expires=1793148000&signature=...","expires_at":1793148000}
```

`url` 拼上 `BASE_URL` 后可在浏览器直接打开，无需 Authorization。签名仅授权此视频下载，不包含 API Key；过期后重新申请。普通 `/content` 地址仍要求 API Key，签名链接也支持 Range。

任务元信息保存在 Docker `video-data` 卷的 `desktop-jobs/`，正常提交后的任务可以在服务重启后继续查询。下载依赖 Bot 网关和上游附件仍然可访问，不等于本地永久归档。

## xAI 风格视频创建和查询

```bash
curl -sS "$BASE_URL/v1/videos/generations" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"grok-bot-video",
    "prompt":"一只橘猫在樱花树下散步",
    "duration":8,
    "aspect_ratio":"16:9",
    "resolution":"720p"
  }'
```

| 字段 | 类型 | 默认 | 取值 |
|---|---|---|---|
| `model` | string | `grok-bot-video` | 仅此适配器 ID |
| `prompt` | string | 必填 | 1–32000 字符 |
| `duration` | integer | 4 | 1–15，提交为 `duration_seconds` |
| `aspect_ratio` | string | `16:9` | `1:1`、`16:9`、`9:16`、`4:3`、`3:4`、`3:2`、`2:3` |
| `resolution` | string | `720p` | `480p`、`720p`、`1080p` |
| `image` | object | 可选 | `{ "url": "https://.../cat.png" }` 或图片 data URL |

HTTP 200 返回：

```json
{"request_id":"video_12345678-1234-4123-8123-123456789abc"}
```

查询同一个 `/v1/videos/{request_id}`，按该任务创建时选择的 xAI 格式返回：

```json
{
  "request_id":"video_12345678-1234-4123-8123-123456789abc",
  "status":"done",
  "agent_id":"实际BotID",
  "delivery":"accepted",
  "backend":"grok_bot_task",
  "error":null,
  "generation_tool_verified":true,
  "video":{"url":"/v1/videos/video_12345678-1234-4123-8123-123456789abc/content"}
}
```

状态为 `pending`、`done`、`failed`。下载仍需 API_TOKEN。**这里兼容请求/结果的主要形状，实际调度 Bot 工具；不是把桌面 Key 转为官方 xAI Key。** 实际视频时长、分辨率未解析时不会伪造返回。`edits`、`extensions` 返回 501；当前也不提供视频列表、删除、remix、webhook、参考图片数组、首尾帧或关键帧字段。

## OpenAI 风格聊天（当前 Docker 已关闭）

```bash
curl -sS "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"grok-bot","messages":[{"role":"user","content":"用一句话介绍你自己"}],"stream":false}'
```

只支持 `model: grok-bot`、`messages`、`stream`。messages 为 1–100 项，role 支持 `system`、`developer`、`user`、`assistant`，content 只支持文本，每项最多 32000 字符，总转换后文本最多 64000 字符。不会把未知 `temperature`、工具调用、JSON schema、多模态等字段静默忽略；它们返回 400。

每个调用创建独立 Bot，将完整消息历史作为文本上下文提交；role 是上下文信息，不能保证底层原始 Chat Completions 的角色隔离语义。接口等待自己 nonce 对应的任务结算和最终文本，默认 120 秒。它不是底层模型直连。

JSON 结果示例：

```json
{
  "id":"chatcmpl-12345678-1234-4123-8123-123456789abc",
  "object":"chat.completion",
  "created":1793102400,
  "model":"grok-bot",
  "choices":[{"index":0,"message":{"role":"assistant","content":"我是你的 Grok Bot 助手。"},"finish_reason":"stop"}],
  "backend":"grok_bot_task",
  "agent_id":"实际BotID",
  "job_id":"chat_12345678-1234-4123-8123-123456789abc"
}
```

`stream:true` 返回 `text/event-stream`；等待阶段发送 SSE 注释保活，任务完成后发送文本 delta、`finish_reason: stop` 和 `data: [DONE]`。这是最终结果的 SSE 封装，不声称逐 token 实时流，也不会编造 usage。响应头 `X-Grok-Bot-Job-Id` 可用于记录任务。流开始后的错误通过 `data: {"error":...}` 返回。

## 失败、恢复和配置

标准错误示例：

```json
{"error":{"code":"desktop_asleep","message":"Grok Bot cloud computer is asleep. Open the desktop app to wake it; re-export the session if its gateway changed"}}
```

- 401：客户端令牌错误；400/413/415：参数或请求体错误。
- 503 `desktop_asleep`：上游 HTTP 417，先在 Win10 打开 Grok Bot 并进入会话唤醒。网关变化时重新导出凭证并替换服务器文件，无需重启。
- 503：凭证缺失或过期；429：限流；502/504：上游错误或超时。
- 任务 `failed`：`no_output` 表示任务结算但没有可用结果；`bot_task_failed` 表示 Bot 结算失败；可用 `agent_id` 调 `/v1/bots/{id}/transcript` 查看原因或桌面中处理权限。
- `submission_uncertain`：提交中断，可能已经到达 Bot；不会自动重新创建 Bot 或重发生成。应先查看该 Bot，避免重复任务。
- `job_timeout`：查询期限内未完成。不会自动取消已经运行的上游任务，先查看桌面状态再决定是否另发。

每个 API 请求都会创建 Bot，可能使用账户额度，Bot 会保留在桌面账户中供排查。不会自动清理或删除。生成权限、审批和额度由现有 Grok Bot 账户决定。

默认 Docker 中的配置：

```json
{
  "grokBot": {
    "enabled":true,
    "credentialsFile":"/app/secrets/grok-bot-session.json",
    "requestTimeoutMs":30000,
    "videoEnabled":true,
    "chatEnabled":false,
    "jobsDir":"/app/data/desktop-jobs",
    "jobTimeoutMs":1800000,
    "chatTimeoutMs":120000,
    "pollIntervalMs":2000,
    "maxConcurrentJobs":4
  },
  "video":{"enabled":false}
}
```

`maxConcurrentJobs` 限制同时进行的创建/上传/提交阶段，不限制已经被 Bot 接收的任务总数。视频状态在查询时更新，不启动重复提交的后台重试。部署时保留数据卷，不使用 `docker compose down -v` 删除任务记录。完整网关依据见 [协议核对记录](desktop-protocol.md)。

导出脚本若提示找不到 `gateway-descriptor.json`，新版会自动查找常见 Grok/Cursor 数据目录；也可通过 `--app-dir` 指定实际目录。如果描述文件确实已不存在，但保留了之前导出的网关凭证，可以复用它，只补充本机账户凭证：

```powershell
node .\export-grok-bot-session.cjs --include-backend --gateway-session "$env:USERPROFILE\grok-bot-session.json" --output "$env:USERPROFILE\grok-bot-session-with-backend.json"
```

`--gateway-session` 必须指向之前导出的 JSON 文件。仍需同一 Windows 用户的数据目录包含 `Local State` 和 `sand-secrets.json`。多个候选目录会要求用 `--app-dir` 明确选择；不会猜测账户。`--inspect` 只显示指定目录中文件是否存在及字段类型。
