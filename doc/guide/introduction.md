# 项目介绍

tgfileui-work 是一个运行在 Cloudflare Workers 上的 Telegram 频道文件代理和媒体库管理工具。

## 核心功能

### 来源管理
- 添加多个 Telegram 频道作为来源
- 每个来源配置独立的 MTProto 凭证（API ID + API Hash + Session String）
- 可选配置 Bot Token，用于 ≤ 20MB 文件的 CDN 直链加速
- 支持五种内容类型：视频、音频、图片、电子书、文件

### 媒体扫描
- 增量扫描：每次只拉取上次扫描点之后的新消息
- 处理一条、写入一条，不会因中断丢失已处理数据
- SSE 实时推送扫描进度到前端
- 支持手动清空并重新全量扫描

### 媒体管理
- 支持手动编辑：封面、标题、简介、评分、分类
- 自动刮削：根据文件名搜索元数据
  - 视频 → TMDB（主）+ 豆瓣（备）
  - 音乐 → MusicBrainz
  - 电子书 → Google Books + 豆瓣读书
- 批量刮削：只处理未刮削的条目，已刮削的跳过

### 公开前台
- 按频道/类型/关键词筛选媒体列表
- 媒体详情页展示封面、简介、评分
- 多种文件操作：
  - **在线播放**：ArtPlayer 视频播放器，支持 HLS
  - **代理下载**：通过 Worker 中转，支持 Range 请求
  - **直链下载**：302 跳转到 TG CDN（需 Bot Token）
  - **STRM 文件**：生成 `.strm` 文件供 Infuse/Emby/Jellyfin 使用

## 技术架构

```
Cloudflare Pages (React + Antd 5)
         ↓ REST API / SSE
Cloudflare Worker (Hono)
         ↓
  D1 Database    KV Store      MTKruto
  (媒体/来源)   (TG Session)  (MTProto客户端)
                                    ↓
                             Telegram MTProto API
```
