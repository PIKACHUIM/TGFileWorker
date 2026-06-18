# 部署方式

## 前提条件

- Cloudflare 账号
- Node.js 18+
- 已安装 `wrangler` CLI：`npm i -g wrangler`

## 步骤一：创建 Cloudflare 资源

```bash
# 登录
wrangler login

# 创建 D1 数据库
wrangler d1 create tgfileui-work
# 记录输出的 database_id

# 创建 KV 命名空间
wrangler kv:namespace create TG_SESSIONS
# 记录输出的 id
```

## 步骤二：配置 wrangler.toml

编辑 `worker/wrangler.toml`，填入上一步得到的 ID：

```toml
[[d1_databases]]
binding = "DB"
database_name = "tgfileui-work"
database_id = "你的D1数据库ID"  # ← 替换这里

[[kv_namespaces]]
binding = "KV"
id = "你的KV命名空间ID"  # ← 替换这里

[vars]
JWT_SECRET = "替换为随机字符串"  # ← 替换这里，建议32位随机字符
WORKER_URL = "https://tgfileui-work.your-subdomain.workers.dev"  # ← 部署后填入
```

## 步骤三：部署 Worker

```bash
cd worker
npm install
npm run deploy
```

部署成功后记录 Worker URL（格式如 `https://tgfileui-work.xxx.workers.dev`），更新 `wrangler.toml` 中的 `WORKER_URL`，再次 `npm run deploy`。

## 步骤四：部署前端到 Cloudflare Pages

**方式 A：直接构建上传**

```bash
cd frontend
npm install

# 修改 vite.config.ts 中的 API proxy 为实际 Worker URL
# 或设置环境变量 VITE_API_BASE=https://your-worker.workers.dev

npm run build
# 上传 dist/ 目录到 Cloudflare Pages
```

**方式 B：连接 GitHub 自动部署**

1. 将项目推送到 GitHub
2. Cloudflare Pages → Create a project → Connect to Git
3. 构建设置：
   - Build command: `cd frontend && npm install && npm run build`
   - Build output directory: `frontend/dist`
4. 环境变量：无需额外配置（API 通过相对路径 `/api` 访问）

::: tip
Pages 和 Worker 需要在同一个 Cloudflare 账号下，可以通过 Pages 的 Functions 功能代理 API 请求，或在 `vite.config.ts` 中设置正确的 API base URL。
:::

## 步骤五：获取 Telegram Session String

来源配置需要 MTProto Session String，可通过以下方式获取：

1. 使用 [Telegram 官方客户端导出 session](https://github.com/LonamiWebs/Telethon/wiki/String-sessions)
2. 使用 Telethon Python 脚本：

```python
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

api_id = 你的API_ID
api_hash = "你的API_HASH"

with TelegramClient(StringSession(), api_id, api_hash) as client:
    print(client.session.save())
```

3. 运行后按提示登录，最终输出的字符串即为 Session String

## 初始化

首次访问前端地址，会自动跳转到初始化页面，创建管理员账号即可。
