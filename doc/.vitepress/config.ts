import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'tgfileui-work',
  description: 'Telegram 频道文件代理与媒体库管理工具',
  lang: 'zh-CN',
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '部署', link: '/guide/deployment' },
      { text: '教程', link: '/guide/tutorial' },
    ],
    sidebar: [
      {
        text: '指南',
        items: [
          { text: '项目介绍', link: '/guide/introduction' },
          { text: '部署方式', link: '/guide/deployment' },
          { text: '功能教程', link: '/guide/tutorial' },
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/your/tgfileui-work' }
    ],
    footer: { message: 'Released under the MIT License.' }
  }
})
