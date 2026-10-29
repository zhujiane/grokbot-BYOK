# Grok 视频生成 API

本文描述需要 `XAI_API_KEY` 的官方后端。使用 Windows Grok Bot 已有登录信息的 Docker 部署，请看 [桌面视频/聊天 API](desktop-api.md)；该部署使用 `grok-bot-video` 和统一的 `API_TOKEN`，不需要官方 Key。两个视频后端使用相同路径，须选择一个启用。

项目原先只有聊天推理的 Connect 接口，没有视频生成。新增接口直接使用 xAI 官方视频 API，与聊天 provider、聊天模型别名和故障切换独立。全部请求使用普通 HTTP，无需 Connect 封包。

支持 xAI 原生格式和 OpenAI 风格的创建、查询、下载格式。两种格式的实际生成模型都是 Grok；这里没有接入 Sora，也不会把 `sora-2` 静默转换为 Grok。OpenAI 风格只兼容本文列出的字段及接口，不包含列表、删除、remix、webhook、缩略图等完整 OpenAI Videos 功能。

参考官方文档（2026-10-27 核对）：[xAI Videos](https://docs.x.ai/developers/rest-api-reference/inference/videos)、[xAI 视频生成](https://docs.x.ai/developers/model-capabilities/video/generation)、[OpenAI 视频创建格式](https://developers.openai.com/api/reference/resources/videos/methods/create)。OpenAI 官方页面注明 Videos API 已于 2026-09-24 关闭；本项目复用其请求格式作为 Grok 适配层。

## 启用

如无配置，先复制示例；已有配置则只添加 `video` 段：

```bash
cp config/config.example.json config/config.json
```

在 `.env` 中填写：

```dotenv
XAI_API_KEY=你的xAI官方API密钥
VIDEO_API_TOKEN=你为调用方设置的长随机令牌
```

在 `config/config.json` 添加或修改：

```json
{
  "video": {
    "enabled": true,
    "baseUrl": "https://api.x.ai/v1",
    "apiKey": "${XAI_API_KEY}",
    "apiToken": "${VIDEO_API_TOKEN}",
    "defaultModel": "grok-imagine-video",
    "jobsDir": "data/video-jobs",
    "requestTimeoutMs": 60000,
    "maxBodyBytes": 20971520
  }
}
```

这是配置片段，合并到现有配置顶层。`enabled` 默认 false；开启时两个密钥必须有效填写，否则启动时报错。`defaultModel` 可改成账户可用的 `grok-imagine-video-1.5` 或其他 `grok-imagine-video-*` 模型，具体权限由 xAI 决定。现有 OpenCode/OpenRouter 聊天 Key 不能代替这里的 xAI Key。

启动服务（不需要运行会修改 Grok Bot host 的 setup）：

```bash
npm ci
npm run dev
```

默认地址为 `http://127.0.0.1:8788`。需要对外监听可设置 `SHIM_HOST=0.0.0.0`，通过 HTTPS 反向代理发布。新增视频路由都校验 `Authorization: Bearer VIDEO_API_TOKEN`；此令牌与上游 `XAI_API_KEY` 独立。原有 Connect 聊天接口的访问行为保持原样，公开部署时应在代理上只开放需要的路由。

## 接口列表

| 方法 | 路径 | 格式/用途 |
|---|---|---|
| POST | `/v1/videos/generations` | xAI：文生视频、图生视频 |
| POST | `/v1/videos/edits` | xAI：编辑视频 |
| POST | `/v1/videos/extensions` | xAI：续写视频 |
| GET | `/v1/videos/{request_id}` | xAI：查询上游任务 |
| POST | `/v1/videos` | OpenAI 风格：创建 Grok 视频任务 |
| GET | `/v1/videos/{video_id}` | OpenAI 风格：查询本地任务 |
| GET | `/v1/videos/{id}/content` | 下载 MP4；两种任务 ID 均支持 |

所有接口都需要 Bearer 令牌。以下示例假设终端已设置 `VIDEO_API_TOKEN`。

## xAI 格式（推荐）

### 提交生成

```bash
curl -sS http://127.0.0.1:8788/v1/videos/generations \
  -H "Authorization: Bearer $VIDEO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "grok-imagine-video",
    "prompt": "一只橘猫在樱花树下散步，电影质感，镜头缓慢向前推进",
    "duration": 6,
    "aspect_ratio": "16:9",
    "resolution": "720p"
  }'
```

返回 HTTP 200，内容示意：

```json
{"request_id":"41eb9a5f-cbd4-9f21-8d59-79005f1e61b7"}
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `model` | string | 可选，默认 `video.defaultModel` |
| `prompt` | string | 必填，非空，最多 32000 字符 |
| `duration` | integer | 可选，1–15 秒，具体支持由模型决定 |
| `aspect_ratio` | string | 可选：`1:1`、`16:9`、`9:16`、`4:3`、`3:4`、`3:2`、`2:3` |
| `resolution` | string | 可选：`480p`、`720p`、`1080p`，具体支持由模型决定 |
| `image` | object | 图生视频输入，例如 `{"url":"https://example.com/cat.png"}`，也可使用 base64 data URL |
| `video` | object | 编辑和续写必填，例如 `{"url":"https://example.com/input.mp4"}` |

其他 xAI 原生选项（例如 `reference_images`、`last_frame`）原样转发，由 xAI 校验。当前本地 `image`/`video` 校验要求 `url`；未实现 Files API 上传或 `file_id` 输入。视频编辑的自定义时长、分辨率等限制由上游决定。

### 图生视频

```bash
curl -sS http://127.0.0.1:8788/v1/videos/generations \
  -H "Authorization: Bearer $VIDEO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "让图片中的猫咪抬头看向镜头",
    "image": {"url":"https://example.com/cat.png"},
    "duration": 6
  }'
```

编辑/续写：向 `/v1/videos/edits` 或 `/v1/videos/extensions` POST `prompt`、`video.url`、可选 `model`；同样返回 `request_id`。

### 查询结果

将返回的 ID 填入：

```bash
REQUEST_ID=替换成返回的request_id
curl -sS "http://127.0.0.1:8788/v1/videos/$REQUEST_ID" \
  -H "Authorization: Bearer $VIDEO_API_TOKEN"
```

未完成时：

```json
{"status":"pending"}
```

完成时的示意结构：

```json
{
  "status": "done",
  "video": {
    "url": "https://vidgen.x.ai/.../video.mp4",
    "duration": 6,
    "respect_moderation": true
  },
  "model": "grok-imagine-video"
}
```

终态还有 `failed`、`expired`。查询响应中的额外字段原样保留。建议每 5 秒查询一次，到终态停止。上游链接是临时链接，需要及时下载。

## OpenAI 风格格式

### 提交生成

```bash
curl -sS http://127.0.0.1:8788/v1/videos \
  -H "Authorization: Bearer $VIDEO_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "grok-imagine-video",
    "prompt": "一只橘猫在樱花树下散步，镜头缓慢向前推进",
    "seconds": "8",
    "size": "1280x720"
  }'
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `model` | string | 可选，默认配置模型，只接受 `grok-imagine-video` 或 `grok-imagine-video-*` |
| `prompt` | string | 必填，非空，最多 32000 字符 |
| `seconds` | string | 可选，`"4"`、`"8"`、`"12"`，默认 `"4"`；转为 xAI `duration` |
| `size` | string | 可选，`"1280x720"` 或 `"720x1280"`，默认后者；映射为 720p、16:9 或 9:16 |
| `input_reference` | object/file | JSON 使用 `{"image_url":"https://example.com/cat.png"}`，或完整图片 data URL；multipart 支持 JPEG/PNG/WebP 文件 |

不支持的 size、Sora 模型、未知字段会返回 400，不会近似替换。参考图片尺寸和是否接受图片由上游校验。

multipart 示例：

```bash
curl -sS http://127.0.0.1:8788/v1/videos \
  -H "Authorization: Bearer $VIDEO_API_TOKEN" \
  -F 'model=grok-imagine-video' \
  -F 'prompt=让图片中的猫咪抬头看向镜头' \
  -F 'seconds=4' \
  -F 'size=1280x720' \
  -F 'input_reference=@cat.png;type=image/png'
```

创建成功返回 HTTP 200，内容示意：

```json
{
  "id": "video_6f45e3ec-20bf-47ac-8216-38e0ad12b611",
  "object": "video",
  "model": "grok-imagine-video",
  "prompt": "一只橘猫在樱花树下散步，镜头缓慢向前推进",
  "created_at": 1793088000,
  "seconds": "8",
  "size": "1280x720",
  "status": "queued",
  "progress": 0,
  "error": null
}
```

### 查询与下载

```bash
VIDEO_ID=替换成返回的video_id
curl -sS "http://127.0.0.1:8788/v1/videos/$VIDEO_ID" \
  -H "Authorization: Bearer $VIDEO_API_TOKEN"
```

返回同一个 video 对象，`status` 为 `in_progress`、`completed` 或 `failed`。`progress` 优先取上游值，未报告时为 0，完成时为 100；不会编造进度。完成时额外附带 `video` 对象和临时下载 URL。失败示意：

```json
{
  "id": "video_6f45e3ec-20bf-47ac-8216-38e0ad12b611",
  "object": "video",
  "model": "grok-imagine-video",
  "prompt": "示例提示词",
  "created_at": 1793088000,
  "seconds": "8",
  "size": "1280x720",
  "status": "failed",
  "progress": 0,
  "error": {"code":"expired","message":"xAI video generation expired"}
}
```

状态映射：`pending → in_progress`、`done → completed`、`failed/expired → failed`。

生成完成后下载（原生 xAI `request_id` 也可用于这个路径）：

```bash
curl --fail-with-body -sS "http://127.0.0.1:8788/v1/videos/$VIDEO_ID/content" \
  -H "Authorization: Bearer $VIDEO_API_TOKEN" \
  -o output.mp4
```

成功返回 `Content-Type: video/mp4` 和二进制内容；未完成返回 409。仅支持视频本体，不支持 thumbnail/spritesheet。下载时不会将本地令牌或 xAI Key 发送给视频存储域名。

## 错误、持久化与运行边界

错误使用普通 HTTP 状态码和统一 JSON：

```json
{"error":{"message":"Invalid video API token","type":"invalid_request_error","code":"unauthorized"}}
```

| HTTP | 含义 |
|---|---|
| 400 / 422 | 参数错误或上游拒绝参数 |
| 401 | 调用方令牌错误 |
| 404 | 接口或本地任务不存在，或上游任务不存在 |
| 409 | 视频尚未完成或已失败，无法下载 |
| 413 | 请求体超过限制，默认 20 MiB（包括 Base64/表单开销） |
| 415 | 请求 Content-Type 不支持 |
| 429 | xAI 限流 |
| 500 | 上游已接受任务但本地记录写入失败，错误中附带 `request_id` 可用于原生查询 |
| 502 | 上游授权、服务、响应或下载异常 |
| 503 | 视频 API 未启用 |
| 504 | 请求超时，提交结果可能未知 |

生成 POST 不自动重试，避免一次网络超时创建多个计费任务。超时后不要盲目重复提交；目前没有本地幂等键或取消机制。上游详细错误正文不回传，避免泄露凭据或大体积输入。

OpenAI 风格任务的 ID 映射及提示词保存在 `jobsDir`（不保存 API Key、参考图字节和视频内容），重启后可继续查询。请保留这个目录；多实例需共享该目录及相同上游配置。记录没有自动清理，需自行管理留存。切换上游地址/账号后旧任务不保证可查。xAI 原生任务不需要本地记录，但查询需要同一上游账号。

当前验证使用模拟 xAI 服务，覆盖 HTTP 路由、参数转换、状态映射、重启读取、鉴权、上传和下载，不代表真实账户的视频生成已验证。真实可用性取决于 xAI Key、账户权限、余额及模型支持。
