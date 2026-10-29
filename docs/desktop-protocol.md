# Grok Bot 0.77.0 桌面协议核对记录

核对用户提供的已解包 `app.asar/`，`package.json` 版本为 0.77.0，构建时间为 2026-10-26T19:11:03.333Z。安装包原文件不提交到仓库，也不进入 Docker 镜像。

## 确认的能力

- `dist/electron-main/proto.cjs` 定义了 `GenerateVideoArgs`：`prompt`、`file_path`、`image_path`、`reference_image_paths`、`duration_seconds`、`aspect_ratio`、`resolution`、`last_frame_path`、`keyframes`。
- `GenerateVideoSuccess` 返回 `file_path` 和 `duration_seconds`；失败返回 `error`。它属于 Agent 工具调用消息，不是已发现的独立 REST 方法。
- `dist/node-agent-coordinator/main.cjs` 包含压缩的 `sand-gateway` JSON Schema，源标识为 `sand/src/shared/rpc/gateway.ts`。以 base64 + deflate-raw 解压读取，未运行安装包代码。
- `createAgent` 必填 `name`、`description`，返回 `{agent, transcript}`；`sendPrompt` 必填 `agentId`、`prompt`，可传 `clientNonce`、`attachmentPaths`，返回 `{accepted?: boolean}` 或 null。
- `getAgentTranscriptTail` 返回 `{entries, nextBeforeSeq?}`。`tool-call` 条目含 `name` 与 `status: pending|done|failed`；`send-message` 的附件消息含 `message.type: attachment` 与 `message.url`。
- `readAttachmentChunk` 接收 `agentId?`、`path`、`offset`、`length`、`videoPlayback?`，返回 `{bytesBase64,totalSize,mime,resolvedName?}` 或 null。偏移 0、长度 0 用于读取元信息。
- Bot 摘要的 `lastTurnSettlement` 含 `clientNonce`、`outcome: success|error|cancelled`、`settledAtMs`，适配器据此关联自己提交的任务。
- `promptAcceptanceStatus` 还要求 `accountSlot`，此前仅传 Bot ID 和 nonce 不完整，已修正 REST 参数。
- 桌面代码把网关 HTTP 417 识别为 `pod_hibernated`；适配器将其返回为 HTTP 503、`desktop_asleep`，提示从桌面端唤醒。

## 适配边界

没有在网关 Schema 中发现独立 `generateVideo`、原始 chat completions 或模型权益目录方法。现有 gateway session 可以调度 Bot，不能据此当作官方 xAI Key。

本项目的 `grok-bot` / `grok-bot-video` 是任务适配器名称。每次请求创建独立 Bot，通过其已有工具工作。视频参数作为工具执行要求提交，底层实际模型、实际时长与编码不能仅从任务回执确认；返回的参数是请求值。下载使用认证网关分块读取，不把凭证发送给附件 URL。

2026-10-28 实测：桌面唤醒后完成创建、生成、查询和 MP4 下载。真实 transcript 仅有 user/send-message，没有 GenerateVideo 工具条目；结算 clientNonce 为用户消息的 requestId，而非传入的 clientNonce，现通过回显消息绑定。桌面返回的 file:// 附件路径读到 null，但 Bot 可将原文件复制到 /tmp 后供 readAttachmentChunk 读取。此前适配器用过一次性路径恢复，现已按需求移除，后续不追加对话，并明确返回 generation_tool_verified:false。实际下载 4,541,524 字节，MP4 元信息为 4.042 秒、1280×720。下载 SHA-256 与原文件哈希一致。

协议是内部实现，后续桌面版本可能改变；升级后需复核。安装包 `proto.cjs` SHA-256：`242393d254a9c6069a13c1ade475146a497a61d483f6098347f5ffb90d2fdf42`。


## 直接附件 URL（已验证账户认证，旧附件未进入存储）

桌面 `main-app.cjs` 的 `yae/a6e` 组合通过账户后端 `aiserver.v1.GrokBotService/ResolveGrokBotAttachmentReads` 解析附件别名。参数 `{agentId, paths:[canonicalPath]}`，canonicalPath 使用 `/home/box/agent-data/agents/{id}/assets/{hash}.mp4`。回复 reads 包含 path、outcome（STORE=1）、url、expiresAtMs、contentType、sizeBytes、etag。桌面随后以 HTTP Range 直接读取签名 URL，凭证不转发给存储服务。另有 `ReadGrokBotAgentAttachmentChunk` 账户后端分块回退，本次未新增此回退。

实际网关 `/api/resolveGrokBotAttachmentReads` 返回 404 unknown-method，不能只用 gatewayToken 调用。桌面账户 token 位于 `%APPDATA%/Grok Bot/sand-secrets.json`：cursor-accounts 字符串中记录 active 与各账户，加密 cursor-access-token 用同一 Windows SafeStorage 解密。新版导出器只补导当前账户 access token、machine ID、team ID，不导出 refresh token、不刷新令牌、不登录。

直接解析、缓存、Range、签名失效重取、凭证隔离与缺少凭证的错误均已模拟测试；2026-10-28 已取得 Windows 的账户访问令牌并导入，ResolveGrokBotAttachmentReads 实际返回 HTTP 200。对旧视频原始别名及已知真实文件哈希别名均返回 GROK_BOT_ATTACHMENT_READ_OUTCOME_NOT_IN_STORE，未获得签名地址，不能把 STORE 分支称为真实下载验证。桌面唤醒后，服务读取既有 `/tmp/` 文件再次成功，SHA-256 与此前一致。新任务已要求 GenerateVideo 在首次请求中直接写入独立 `/tmp/` 文件并返回 JSON 路径；路径识别和单次提交已自动测试，新生成尚未再实测。
