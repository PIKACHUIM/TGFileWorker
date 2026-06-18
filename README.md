# tgfileui-work

Telegram 频道文件代理与媒体库管理工具，运行在 Cloudflare Workers 上。

## 功能

- **来源管理**：添加多个 TG 频道，配置 MTProto 凭证，支持视频/音频/图片/电子书/文件五种类型
- **频道扫描**：增量扫描历史消息，SSE 实时推送进度，处理一条存一条
- **刮削支持**：TMDB、豆瓣、MusicBrainz、Google Books，自动补全封面/简介/评分
- **多种访问方式**：在线播放、Worker 代理下载、TG CDN 直链、STRM 文件生成
- **暗黑模式**：跟随系统或手动切换

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Hono + Cloudflare Worker |
| 数据库 | Cloudflare D1 (SQLite) |
| Session 存储 | Cloudflare KV |
| TG 客户端 | MTKruto (MTProto over Workers) |
| 前端 | React 18 + Antd 5 + Vite |
| 部署 | CF Pages (前端) + CF Worker (后端) |
| 文档 | VitePress |

## 快速部署

```bash
# 1. 创建 D1 和 KV
wrangler d1 create tgfileui-work
wrangler kv:namespace create TG_SESSIONS

# 2. 填入 wrangler.toml
# database_id, kv id, JWT_SECRET, WORKER_URL

# 3. 部署 Worker
cd worker && npm install && npm run deploy

# 4. 构建前端
cd frontend && npm install && npm run build
# 将 dist/ 部署到 Cloudflare Pages
```

详细部署文档：[doc/guide/deployment.md](doc/guide/deployment.md) 或访问文档站。

## 目录结构

```
tgfileui-work/
├── worker/          # Hono 后端（Cloudflare Worker）
├── frontend/        # React + Antd 5 前端
└── doc/             # VitePress 文档站
```

## 文档

```bash
cd doc && npm install && npm run dev
```

## 参考项目

- [TG-FileStreamBot](https://github.com/EverythingSuckz/TG-FileStreamBot) — 频道文件流式传输实现参考
- [OpenList](https://github.com/OpenListTeam/OpenList) — 媒体库数据模型与刮削逻辑参考

## License

MIT
