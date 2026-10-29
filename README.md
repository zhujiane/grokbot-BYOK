# Grok Bot 视频 API

使用 Grok Bot 桌面端已有登录凭证，通过 Docker 提供视频生成 API。默认模型 `grok-bot-video`，无需 `XAI_API_KEY`。每个任务创建独立 Bot，只提交一次生成请求；查询与下载不会追加对话。

## 网页使用

访问部署地址（当前为 `http://{ip}:8789/`），用 `.env` 中的 `UI_USERNAME` / `UI_PASSWORD` 登录。登录会话有效期 24 小时，页面调用接口、播放和下载均无需填写 API Key。

1. 左下角「登录凭证」可下载导出脚本，在已登录 Grok Bot 的 Windows 上按提示执行，再上传生成的 JSON。
2. 左侧新建、切换或删除会话；右侧按对话顺序显示提示词、进度和视频。底部输入提示词，Enter 生成，Shift + Enter 换行。
3. 选择「首尾帧模式」或「多参考图模式」（最多 8 张），直接上传、拖拽或粘贴图片。底部可设置时长、比例、分辨率；「配置」内可切换 xAI / OpenAI、引用 HTTPS 图片、添加最多 16 个关键帧、查看请求参数。两种模式仅提交当前模式的图片，关键帧独立生效。
4. 切换会话后任务仍自动查询；完成后直接预览、下载 MP4 或复用提示词。查询和下载不会追加 Bot 对话。上游多图效果仍取决于工具实际支持。

浏览器 `localStorage` 保存会话、各会话参数草稿与任务记录，旧版任务自动迁入「之前的视频任务」。不保存账号密码、桌面凭证或图片；图片仅在当前页面内存中随会话保留，刷新后需重新添加。删除会话仅删除本机记录，无需数据库。

网页上传的凭证以 `0600` 权限写入 `video-data` 卷的 `/app/data/ui-session.json`，立即生效且优先于只读 `secrets/grok-bot-session.json`；后续更新请继续在网页上传。已导入的凭证不会回传浏览器。清空浏览器历史不会删除服务端任务和凭证。

网页登录使用 HttpOnly / SameSite Cookie。局域网 HTTP 可使用；公网访问请在反向代理上启用 HTTPS。修改 `UI_PASSWORD` 后重建容器会使已有登录会话失效：`docker compose up -d`。

## 登录凭证

在 Windows 打开已登录的 Grok Bot，连接云电脑。将 [导出脚本](scripts/export-grok-bot-session.cjs) 复制到本机，使用同一 Windows 用户运行 Node.js 22+：

```powershell
node .\export-grok-bot-session.cjs --include-backend --output "$env:USERPROFILE\grok-bot-session-with-backend.json"
```

找不到数据目录时，加 `--app-dir "实际数据目录"`。缺少 `gateway-descriptor.json` 但有旧导出文件时：

```powershell
node .\export-grok-bot-session.cjs --include-backend --gateway-session "$env:USERPROFILE\grok-bot-session.json" --output "$env:USERPROFILE\grok-bot-session-with-backend.json"
```

输出文件必须尚不存在。凭证包含网关及账户访问令牌，私下传到服务器；失效后重新导出并替换，无需重启服务。

## Docker 部署

支持启动后通过网页上传凭证，也可在项目目录手动导入：

```bash
mkdir -p secrets
install -m 600 grok-bot-session-with-backend.json secrets/grok-bot-session.json
sudo chown 1000:1000 secrets secrets/grok-bot-session.json
chmod 700 secrets
```

创建 `.env`（已有部署保留原值）：

```dotenv
API_TOKEN=替换为长随机令牌
UI_USERNAME=admin
UI_PASSWORD=替换为管理员密码
API_BIND_ADDRESS=127.0.0.1
API_PORT=8789
```

局域网访问时将 `API_BIND_ADDRESS` 改为服务器局域网 IP。启动或更新：

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 api
```

首次启动须创建 `secrets` 目录（`mkdir -p secrets`）；不必提前导入凭证。凭证目录只读挂载，网页导入的凭证和任务记录保存在 `video-data` 卷；不要用 `down -v` 删除记录。默认关闭聊天和官方 xAI 后端。

## 视频 API

网页登录后可直接使用视频接口，无需额外传 API Key。外部程序仍可使用 Bearer Token，或先登录 `/ui/login` 获取会话 Cookie；Cookie 登录及写操作须提供与服务地址一致的 `Origin` 请求头。

```bash
BASE_URL=http://{ip}:8789
curl --fail-with-body -c cookies.txt "$BASE_URL/ui/login" \
  -H "Origin: $BASE_URL" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"你的管理员密码"}'
curl --fail-with-body -b cookies.txt "$BASE_URL/v1/videos/generations" \
  -H "Origin: $BASE_URL" -H 'Content-Type: application/json' \
  -d '{"model":"grok-bot-video","prompt":"一只橘猫在花园里散步","duration":4,"aspect_ratio":"16:9","resolution":"720p"}'
```

以下为 Bearer Token 的 Bash 示例。当前部署地址 `http://{ip}:8789`；客户端令牌使用 `.env` 中的 `API_TOKEN`，不要使用桌面凭证里的 token。

```bash
BASE_URL=http://{ip}:8789
export API_TOKEN='你的客户端令牌'

curl -sS "$BASE_URL/healthz"
curl -sS "$BASE_URL/v1/models" -H "Authorization: Bearer $API_TOKEN"
curl -sS "$BASE_URL/v1/auth/status" -H "Authorization: Bearer $API_TOKEN"
```

`/v1/models` 的 `data` 包含 `{"id":"grok-bot-video","object":"model","created":0,"owned_by":"grok-bot-task-adapter"}`。检查云电脑连接可请求 `/v1/bots`，认证方式相同。

### 创建视频

```bash
curl --fail-with-body "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"grok-bot-video","prompt":"一只橘猫在花园里散步，镜头缓缓推进","seconds":"4","size":"1280x720"}'
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | 默认 `grok-bot-video` |
| `prompt` | string | 必填，1–32000 字符 |
| `seconds` | string | `"4"`、`"8"`、`"12"`，默认 `"4"` |
| `size` | string | `1280x720`、`720x1280`，默认前者 |
| `input_reference` | object | 单图/起始图：`{"image_url":"图片地址"}` |
| `reference_images` | array | 多参考图：`[{"url":"图片地址"}]`，1–8 张 |
| `last_frame` | object | 尾帧：`{"url":"图片地址"}` |
| `keyframes` | array | 关键帧：`[{"url":"图片地址","timestamp_seconds":1}]`，1–16 帧 |

所有图片地址支持 HTTPS 或 `data:image/png;base64,...`，Base64 同时支持 JPEG、WebP，不接受裸 Base64。单图片地址最多 16 MiB 字符，整个请求最多 20 MiB（包含 Base64 膨胀）。关键帧时间不能重复，范围为 0 至请求时长，提交时自动按时间排序。多图参数请使用 JSON 请求。

`reference_images`、`last_frame`、`keyframes` 是本项目扩展字段，两种接口都支持；数量限制由适配器设置，不代表模型上限。它们分别映射到 Bot 工具的 `reference_image_paths`、`last_frame_path`、`keyframes`。接入与参数映射已自动测试，上游多图/尾帧/关键帧生成效果尚未实测；实际支持取决于 Bot 的工具和权限，不会主动降级成拼图或单图。

多参考图示例（也可按需组合起始图、尾帧和关键帧）：

```json
{
  "model": "grok-bot-video",
  "prompt": "人物参考第一张，服装参考第二张，人物在花园里行走",
  "seconds": "4",
  "reference_images": [
    {"url": "https://example.com/character.png"},
    {"url": "data:image/jpeg;base64,替换为完整Base64"}
  ]
}
```

首尾帧与关键帧参数示例，添加到创建请求中：

```json
{
  "input_reference": {"image_url": "https://example.com/start.png"},
  "last_frame": {"url": "https://example.com/end.png"},
  "keyframes": [
    {"url": "https://example.com/middle.png", "timestamp_seconds": 2}
  ]
}
```

单张本地图片也可以 multipart 上传：

```bash
curl --fail-with-body "$BASE_URL/v1/videos" \
  -H "Authorization: Bearer $API_TOKEN" \
  -F 'prompt=让图片中的人物自然转头' -F seconds=4 \
  -F 'input_reference=@./start.png;type=image/png'
```

创建返回 HTTP 200，主要字段：

```json
{"id":"video_…","object":"video","model":"grok-bot-video","status":"queued","progress":0,"seconds":"4","size":"1280x720","backend":"grok_bot_task","generation_tool_verified":false,"error":null}
```

### 查询与下载

保存创建返回的 `id`，每 2–5 秒查询一次：

```bash
VIDEO_ID=替换为返回的id
curl -sS "$BASE_URL/v1/videos/$VIDEO_ID" -H "Authorization: Bearer $API_TOKEN"
```

状态为 `queued`、`in_progress`、`completed`、`failed`，失败原因在 `error` 中。完成时主要字段：

```json
{"id":"video_…","status":"completed","progress":100,"error":null,"video":{"url":"/v1/videos/video_…/content"}}
```

下载 MP4，支持 HTTP Range：

```bash
curl --fail-with-body "$BASE_URL/v1/videos/$VIDEO_ID/content" \
  -H "Authorization: Bearer $API_TOKEN" -o result.mp4
```

获取浏览器可打开的 15 分钟免请求头链接：

```bash
curl -sS "$BASE_URL/v1/videos/$VIDEO_ID/download-url" -H "Authorization: Bearer $API_TOKEN"
```

返回 `{"url":"/v1/videos/video_…/content?expires=…&signature=…","expires_at":1793150000}`，将相对 `url` 拼到 `BASE_URL` 后即可打开。下载仍依赖上游文件可访问。

获取上游存储签名链接：`GET /v1/videos/{id}/source-url`，认证方式相同。成功返回 `{"url":"https://…","expires_at":1793150000,"size":4541524,"content_type":"video/mp4"}`。附件未进入存储时返回 404 `source_url_unavailable`，可尝试本服务下载接口。

### xAI 风格入口

```bash
curl --fail-with-body "$BASE_URL/v1/videos/generations" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"grok-bot-video","prompt":"让人物自然转头","duration":4,"aspect_ratio":"16:9","resolution":"720p","image":{"url":"https://example.com/start.png"}}'
```

| 字段 | 说明 |
|---|---|
| `model`、`prompt` | 与上述接口相同 |
| `duration` | 整数 1–15，默认 4 |
| `aspect_ratio` | `1:1`、`16:9`、`9:16`、`4:3`、`3:4`、`3:2`、`2:3`，默认 `16:9` |
| `resolution` | `480p`、`720p`、`1080p`，默认 `720p` |
| `image` | 起始图：`{"url":"HTTPS地址或Base64 Data URL"}` |
| `reference_images`、`last_frame`、`keyframes` | 与上述扩展字段相同 |

创建返回 `{"request_id":"video_…"}`。使用 `/v1/videos/{request_id}` 查询，状态为 `pending`、`done`、`failed`；完成返回 `video.url`，失败返回 `error`。下载接口与上述相同。

### 常见问题

- `401 unauthorized`：检查客户端 `API_TOKEN`。
- `503 desktop_asleep`：在桌面端连接并唤醒云电脑，再查询已有任务。
- 凭证缺失/失效：重新导出并替换 `secrets/grok-bot-session.json`，确认 UID 1000 可读。
- `409 video_not_ready`：等待任务完成。
- `submission_uncertain`：可能已提交，先检查桌面 Bot，避免重复生成。

这些是部分 OpenAI/xAI 格式兼容接口，模型 ID 表示 Bot 任务适配器。生成参数是请求要求；实际模型、分辨率与图片控制效果由 Bot 决定。`generation_tool_verified:false` 表示记录中未公开可核验的工具调用。当前不提供视频编辑、延长或重混。
