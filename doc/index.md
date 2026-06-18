---
layout: home
hero:
  name: tgfileui-work
  text: Telegram 频道文件代理与媒体库
  tagline: 基于 Cloudflare Worker + D1，无服务器部署，支持在线播放、直链下载、刮削
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/deployment
    - theme: alt
      text: 功能介绍
      link: /guide/introduction
features:
  - title: 来源管理
    details: 支持添加多个 Telegram 频道，配置 MTProto 凭证，支持视频、音频、图片、电子书、文件五种类型
  - title: 媒体扫描
    details: 增量扫描频道历史消息，处理一条存一条，SSE 实时推送进度，支持断点续扫
  - title: 智能刮削
    details: 自动识别媒体类型，对接 TMDB、豆瓣、MusicBrainz、Google Books，补全封面/简介/评分
  - title: 多种下载方式
    details: Worker 代理流（在线播放）、TG CDN 直链、STRM 文件生成，兼容 Infuse / Jellyfin 等客户端
  - title: 暗黑模式
    details: 跟随系统或手动切换，Antd 5 dark algorithm，体验一致
  - title: 零成本部署
    details: Cloudflare Worker + D1 + KV + Pages，完全免费额度内可运行
---
