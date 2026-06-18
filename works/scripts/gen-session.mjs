#!/usr/bin/env node

/**
 * mtcute Session 生成工具
 * 
 * 用法：
 *   node scripts/gen-session.mjs <api_id> <api_hash>
 * 
 * 或使用环境变量：
 *   MTCUTE_API_ID=12345 MTCUTE_API_HASH=abc123 node scripts/gen-session.mjs
 * 
 * 运行后，脚本会交互式地要求你输入：
 *   1. 手机号码（国际格式，如 +8613800138000）
 *   2. 验证码（Telegram 发送到手机或 App 的验证码）
 *   3. 两步验证密码（如果设置了的话）
 * 
 * 登录成功后，会输出 mtcute 格式的 session string，
 * 将其复制到来源配置的 session_string 字段即可。
 * 
 * session string 格式为 mtcute v3 格式，
 * 与 Telethon / Pyrogram 的 session string 不兼容。
 */

import { TelegramClient } from '@mtcute/node'
import { writeFileSync } from 'node:fs'

async function main() {
  // 从命令行参数或环境变量获取 API 凭证
  const apiId = process.env.MTCUTE_API_ID || process.argv[2]
  const apiHash = process.env.MTCUTE_API_HASH || process.argv[3]

  if (!apiId || !apiHash) {
    console.error('❌ 请提供 API ID 和 API Hash')
    console.error('')
    console.error('方式 1 - 命令行参数：')
    console.error('  node scripts/gen-session.mjs <api_id> <api_hash>')
    console.error('')
    console.error('方式 2 - 环境变量：')
    console.error('  MTCUTE_API_ID=12345 MTCUTE_API_HASH=abc123 node scripts/gen-session.mjs')
    console.error('')
    console.error('📌 获取 API ID/Hash: https://my.telegram.org/apps')
    process.exit(1)
  }

  console.log('🔑 mtcute Session 生成工具')
  console.log(`   API ID: ${apiId}`)
  console.log(`   API Hash: ${apiHash.slice(0, 8)}...`)
  console.log('')

  const client = new TelegramClient({
    apiId: Number(apiId),
    apiHash: apiHash,
  })

  try {
    // start() 会交互式地要求输入手机号、验证码、密码
    const user = await client.start({
      phone: () => {
        return new Promise((resolve) => {
          process.stdout.write('📱 请输入手机号（国际格式，如 +8613800138000）: ')
          process.stdin.once('data', (data) => {
            resolve(data.toString().trim())
          })
        })
      },
      code: () => {
        return new Promise((resolve) => {
          process.stdout.write('📩 请输入验证码: ')
          process.stdin.once('data', (data) => {
            resolve(data.toString().trim())
          })
        })
      },
      password: () => {
        return new Promise((resolve) => {
          process.stdout.write('🔐 请输入两步验证密码（没有则直接回车跳过）: ')
          process.stdin.once('data', (data) => {
            resolve(data.toString().trim())
          })
        })
      },
    })

    console.log('')
    console.log('✅ 登录成功！')
    console.log(`   用户名: ${user.username || '(无)'}`)
    console.log(`   名称: ${user.displayName}`)
    console.log(`   ID: ${user.id}`)
    console.log(`   是否为 Bot: ${user.isBot}`)

    // 导出 session string
    const session = await client.exportSession()

    console.log('')
    console.log('🎉 mtcute Session String (version 3):')
    console.log('')
    console.log(session)
    console.log('')
    console.log('📋 将上面的 session string 复制到来源配置的 session_string 字段即可。')
    console.log('   注意：此 session string 是 mtcute v3 格式，')
    console.log('   与 Telethon / Pyrogram 的 session string 不兼容。')

    // 保存到文件（可选）
    const sessionFile = 'session.txt'
    writeFileSync(sessionFile, session, 'utf-8')
    console.log(`💾 Session 已保存到 ${sessionFile}`)

  } catch (e) {
    console.error('')
    console.error('❌ 登录失败:', e.message || String(e))
    process.exit(1)
  } finally {
    await client.destroy()
  }
}

main()