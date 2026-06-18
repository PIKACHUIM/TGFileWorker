import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { authMiddleware } from '../middleware/auth'
import { getSourceById, upsertMediaItem, updateSourceSession } from '../db'
import { computeFileHash } from '../utils/hash'
import { DOProxyTransport, patchEarlyTimer } from '../tg/do-proxy-transport'
import { extractNameAndTags, extractNameWithRegex } from '../scraper/name-parser'
import type { Env } from '../types'
import type { Source } from '../db'

// CF Workers 原生支持 WASM 模块导入（import xxx from '*.wasm'），
// esbuild/wrangler 在构建时自动处理 WASM 文件。
// 参考：https://developers.cloudflare.com/workers/runtime-apis/webassembly/
import mtcuteWasmSimd from '../wasm/mtcute-simd.wasm'
import mtcuteWasm from '../wasm/mtcute.wasm'

// 运行时检测 SIMD 支持（与 @mtcute/wasm 的检测逻辑一致）
const SIMD_AVAILABLE = /* @__PURE__ */ WebAssembly.validate(new Uint8Array(
  [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]
))

/**
 * 获取 mtcute WASM 模块（WebAssembly.Module）
 * CF Workers 运行在 V8 引擎上，支持 WASM SIMD，优先使用 SIMD 版本
 */
function getMtcuteWasmModule(): WebAssembly.Module {
  if (SIMD_AVAILABLE) {
    console.log('[WASM] Using SIMD WASM module')
    return mtcuteWasmSimd
  }
  console.log('[WASM] SIMD not available, using standard WASM module')
  return mtcuteWasm
}

const app = new Hono<{ Bindings: Env }>()
app.use('*', authMiddleware)

// ===== Simple Bot API 扫描（通过 getUpdates 获取频道帖子） =====

/**
 * 通过 Bot API 的 getUpdates 直接获取频道帖子
 *
 * 与 scanChannelViaBotAPI（逐条 forwardMessage + deleteMessage）不同，
 * 此方案利用 Bot 作为频道管理员时，频道帖子会以 channel_post 形式出现在 getUpdates 中。
 *
 * 优点：
 * - 不需要 forwardMessage（避免污染频道聊天）
 * - 不需要 deleteMessage（无需清理转发消息）
 * - 每批最多 100 条消息，API 调用次数更少
 * - 无副作用，更稳定可靠
 *
 * 限制：
 * - Bot 必须是频道管理员才能收到 channel_post 更新
 * - getUpdates 仅返回最近 24 小时内的更新（Telegram 限制）
 * - 需要在扫描前设置 webhook 为空（确保使用 long polling）
 *
 * 参考：
 * - https://github.com/cvzi/telegram-bot-cloudflare
 * - https://github.com/codebam/cf-workers-telegram-bot
 */
async function scanChannelViaSimpleBotAPI(
  botToken: string,
  db: D1Database,
  sourceId: number,
  channelId: string,
  sourceType: string,
  lastMessageId: number,
  nameRegex: string | null,
  onProgress: (p: { processed: number; current_file: string; message_id: number; done: boolean; error?: string }) => Promise<void>,
): Promise<number> {
  let maxNewMessageId = lastMessageId
  let processed = 0

  // 1. 确保没有 webhook 设置（getUpdates 和 webhook 互斥）
  const webhookResp = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`)
  const webhookInfo = await webhookResp.json() as any
  if (webhookInfo.ok && webhookInfo.result?.url) {
    console.log('[Scan:SimpleBotAPI] Webhook is set, deleting webhook to enable getUpdates polling')
    const delWebhookResp = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
    })
    const delWebhookData = await delWebhookResp.json() as any
    if (!delWebhookData.ok) {
      console.error('[Scan:SimpleBotAPI] Failed to delete webhook:', delWebhookData.description)
      return -1
    }
  }

  // 2. 获取频道信息，确认 Bot 是管理员
  const chatUrl = `https://api.telegram.org/bot${botToken}/getChat`
  console.log('[Scan:SimpleBotAPI] Getting chat info, channelId:', channelId, 'URL:', chatUrl.replace(botToken, '***'))
  const chatResp = await fetch(chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: channelId }),
  })
  const chatData = await chatResp.json() as any
  console.log('[Scan:SimpleBotAPI] getChat response ok:', chatData.ok, chatData.ok ? '' : 'error:' + chatData.description)
  if (!chatData.ok) {
    const errorMsg = chatData.description === 'Bad Request: chat not found'
      ? 'Bot 不是该频道管理员，无法通过 Bot API 扫描。请将 Bot 添加为频道管理员，或配置 MTProto 凭证 (api_id + api_hash) 使用 MTProto 扫描。'
      : `getChat 失败: ${chatData.description}`
    return -1
  }

  // 3. 通过 getUpdates 获取 channel_post 类型的更新
  // 使用 offset 控制增量：offset = last_update_id + 1
  // 只请求 channel_post 类型，忽略 message / edited_message 等
  let updateOffset = 0  // 初始 offset 为 0，获取所有待处理的 updates
  let hasMore = true

  while (hasMore) {
    const updatesUrl = `https://api.telegram.org/bot${botToken}/getUpdates`
    console.log('[Scan:SimpleBotAPI] Fetching updates, offset:', updateOffset, 'URL:', updatesUrl.replace(botToken, '***'))

    const updatesResp = await fetch(updatesUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset: updateOffset || undefined,
        limit: 100,
        timeout: 0,  // 不使用 long polling，立即返回
        allowed_updates: ['channel_post'],
      }),
    })
    const updatesData = await updatesResp.json() as any

    if (!updatesData.ok) {
      console.error('[Scan:SimpleBotAPI] getUpdates failed:', updatesData.description)
      throw new Error(`getUpdates failed: ${updatesData.description}`)
    }

    const updates = updatesData.result as any[]
    if (!updates || updates.length === 0) {
      console.log('[Scan:SimpleBotAPI] No more updates available')
      hasMore = false
      break
    }

    // 更新 offset：下次请求跳过已处理的 updates
    const lastUpdate = updates[updates.length - 1]
    updateOffset = lastUpdate.update_id + 1

    for (const update of updates) {
      const channelPost = update.channel_post
      if (!channelPost) continue

      const msgId = channelPost.message_id
      if (msgId <= lastMessageId) continue  // 跳过已扫描的消息
      if (msgId > maxNewMessageId) maxNewMessageId = msgId

      const media = channelPost.document || channelPost.video || channelPost.audio || channelPost.voice || channelPost.photo

      if (media) {
        let fileName = ''
        let fileSize = 0
        let mimeType = ''
        let fileUniqueId = ''

        if (channelPost.document) {
          fileName = channelPost.document.file_name || `document_${msgId}`
          fileSize = channelPost.document.file_size || 0
          mimeType = channelPost.document.mime_type || 'application/octet-stream'
          fileUniqueId = channelPost.document.file_unique_id || String(msgId)
        } else if (channelPost.video) {
          fileName = channelPost.video.file_name || `video_${msgId}`
          fileSize = channelPost.video.file_size || 0
          mimeType = channelPost.video.mime_type || 'video/mp4'
          fileUniqueId = channelPost.video.file_unique_id || String(msgId)
        } else if (channelPost.audio) {
          fileName = channelPost.audio.file_name || `audio_${msgId}`
          fileSize = channelPost.audio.file_size || 0
          mimeType = channelPost.audio.mime_type || 'audio/mpeg'
          fileUniqueId = channelPost.audio.file_unique_id || String(msgId)
        } else if (channelPost.voice) {
          fileName = `voice_${msgId}.ogg`
          fileSize = channelPost.voice.file_size || 0
          mimeType = 'audio/ogg'
          fileUniqueId = channelPost.voice.file_unique_id || String(msgId)
        } else if (channelPost.photo) {
          const photo = channelPost.photo[channelPost.photo.length - 1]
          fileName = `photo_${msgId}.jpg`
          fileSize = photo.file_size || 0
          mimeType = 'image/jpeg'
          fileUniqueId = photo.file_unique_id || String(msgId)
        }

        if (fileName && fileSize > 0) {
          const mediaType = detectMediaType(mimeType, sourceType)
          const fileHash = await computeFileHash(fileName, fileSize, mimeType, fileUniqueId)
          const parsed = nameRegex
            ? extractNameWithRegex(fileName, nameRegex)
            : extractNameAndTags(fileName)

          await upsertMediaItem(db, {
            source_id: sourceId,
            message_id: msgId,
            file_name: fileName,
            file_size: fileSize,
            mime_type: mimeType || null,
            media_type: mediaType,
            file_hash: fileHash,
            message_date: channelPost.date,
            title: parsed.name, description: null, cover: null,
            release_date: null, rating: null, genre: null,
            external_id: null, scraped_at: null,
tags: parsed.tags.length > 0 ? parsed.tags.join(',') : null,
          })

          processed++
          await onProgress({ processed, current_file: fileName, message_id: msgId, done: false })
        }
      }
    }

    // 如果返回不足 100 条，说明已经没有更多更新
    if (updates.length < 100) {
      hasMore = false
    }
  }

  // 4. 扫描完成后，恢复原有的 webhook 设置（如果之前有的话）
  // 注意：如果此 Worker 本身就是 webhook，需要重新设置
  // 这里暂不自动恢复，由用户手动处理或下次请求时重新设置

  return maxNewMessageId
}

// ===== Bot API 扫描（用于配置了 bot_token 的来源） =====

/**
 * 通过 Bot API 的 forwardMessage 逐条获取频道消息
 * 
 * 扫描策略：
 * 1. 先通过 getUpdates 获取频道最近的帖子，确定有效消息 ID 范围
 * 2. 从最新消息 ID 开始向后（递增）扫描，获取更新的消息
 * 3. 如果有旧消息未扫描，向前（递减）扫描获取旧消息
 * 
 * Bot 必须是频道管理员才能使用 forwardMessage
 */
async function scanChannelViaBotAPI(
  botToken: string,
  db: D1Database,
  sourceId: number,
  channelId: string,
  sourceType: string,
  lastMessageId: number,
  nameRegex: string | null,
  onProgress: (p: { processed: number; current_file: string; message_id: number; done: boolean; error?: string }) => Promise<void>,
): Promise<number> {
  let maxNewMessageId = lastMessageId
  let processed = 0
  const FETCH_TIMEOUT_MS = 15000 // 单次 fetch 超时：15秒

  // 辅助函数：执行 forwardMessage fetch
  async function doForwardMessage(messageId: number): Promise<{ fwdData: any; fwdResp: Response } | null> {
    const fwdUrl = `https://api.telegram.org/bot${botToken}/forwardMessage`
    console.log('[Scan:BotAPI] Forwarding message, messageId:', messageId, 'URL:', fwdUrl.replace(botToken, '***'))

    const fwdAbortController = new AbortController()
    const fwdTimeoutId = setTimeout(() => fwdAbortController.abort(), FETCH_TIMEOUT_MS)

    let fwdResp: Response
    try {
      fwdResp = await fetch(fwdUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: botToken.slice(0, botToken.indexOf(':')),
          from_chat_id: channelId,
          message_id: messageId,
        }),
        signal: fwdAbortController.signal,
      })
    } catch (e: any) {
      clearTimeout(fwdTimeoutId)
      if (e.name === 'AbortError') {
        console.warn('[Scan:BotAPI] forwardMessage timed out, messageId:', messageId, 'timeout:', FETCH_TIMEOUT_MS + 'ms')
        return null
      }
      throw e
    }
    clearTimeout(fwdTimeoutId)

    let fwdData: any
    try {
      fwdData = await fwdResp.json() as any
    } catch (e) {
      console.error('[Scan:BotAPI] forwardMessage response is not valid JSON, messageId:', messageId, 'status:', fwdResp.status, 'statusText:', fwdResp.statusText)
      return null
    }

    return { fwdData, fwdResp }
  }

  // 辅助函数：处理消息并入库
  async function handleMessage(msg: any, messageId: number): Promise<boolean> {
    const media = msg.document || msg.video || msg.audio || msg.voice || msg.photo

    if (media) {
      let fileName = ''
      let fileSize = 0
      let mimeType = ''
      let fileUniqueId = ''

      if (msg.document) {
        fileName = msg.document.file_name || `document_${messageId}`
        fileSize = msg.document.file_size || 0
        mimeType = msg.document.mime_type || 'application/octet-stream'
        fileUniqueId = msg.document.file_unique_id || String(messageId)
      } else if (msg.video) {
        fileName = msg.video.file_name || `video_${messageId}`
        fileSize = msg.video.file_size || 0
        mimeType = msg.video.mime_type || 'video/mp4'
        fileUniqueId = msg.video.file_unique_id || String(messageId)
      } else if (msg.audio) {
        fileName = msg.audio.file_name || `audio_${messageId}`
        fileSize = msg.audio.file_size || 0
        mimeType = msg.audio.mime_type || 'audio/mpeg'
        fileUniqueId = msg.audio.file_unique_id || String(messageId)
      } else if (msg.voice) {
        fileName = `voice_${messageId}.ogg`
        fileSize = msg.voice.file_size || 0
        mimeType = 'audio/ogg'
        fileUniqueId = msg.voice.file_unique_id || String(messageId)
      } else if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1]
        fileName = `photo_${messageId}.jpg`
        fileSize = photo.file_size || 0
        mimeType = 'image/jpeg'
        fileUniqueId = photo.file_unique_id || String(messageId)
      }

      if (fileName && fileSize > 0) {
        const mediaType = detectMediaType(mimeType, sourceType)
        const fileHash = await computeFileHash(fileName, fileSize, mimeType, fileUniqueId)
        const parsed = nameRegex
          ? extractNameWithRegex(fileName, nameRegex)
          : extractNameAndTags(fileName)

        await upsertMediaItem(db, {
          source_id: sourceId,
          message_id: messageId,
          file_name: fileName,
          file_size: fileSize,
          mime_type: mimeType || null,
          media_type: mediaType,
          file_hash: fileHash,
          message_date: msg.date,
          title: parsed.name, description: null, cover: null,
          release_date: null, rating: null, genre: null,
          external_id: null, scraped_at: null,
tags: parsed.tags.length > 0 ? parsed.tags.join(',') : null,
        })

        processed++
        if (messageId > maxNewMessageId) maxNewMessageId = messageId
        await onProgress({ processed, current_file: fileName, message_id: messageId, done: false })
        return true
      }
    } else {
      // 消息没有媒体附件（纯文本消息、贴纸、GIF 等），跳过
      console.log('[Scan:BotAPI] No media in message, skipping. messageId:', messageId, 'text:', msg.text?.substring(0, 50) || '(no text)')
      // 仍然调用 onProgress 让前端知道扫描在进展中
      await onProgress({ processed, current_file: '', message_id: messageId, done: false })
    }
    return false
  }

  // 辅助函数：删除转发到 bot 自身的消息
  async function deleteForwardedMessage(messageId: number): Promise<void> {
    if (!messageId) return
    const delUrl = `https://api.telegram.org/bot${botToken}/deleteMessage`
    console.log('[Scan:BotAPI] Deleting forwarded message, messageId:', messageId, 'URL:', delUrl.replace(botToken, '***'))

    const delAbortController = new AbortController()
    const delTimeoutId = setTimeout(() => delAbortController.abort(), FETCH_TIMEOUT_MS)

    try {
      await fetch(delUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: botToken.slice(0, botToken.indexOf(':')), message_id: messageId }),
        signal: delAbortController.signal,
      })
    } catch (e: any) {
      if (e.name === 'AbortError') {
        console.warn('[Scan:BotAPI] deleteMessage timed out, messageId:', messageId, 'timeout:', FETCH_TIMEOUT_MS + 'ms')
      } else {
        console.error('[Scan:BotAPI] deleteMessage failed, messageId:', messageId, 'error:', e.message || String(e))
      }
    } finally {
      clearTimeout(delTimeoutId)
    }
  }

  // ===== 1. 获取频道信息 =====
  const chatUrl = `https://api.telegram.org/bot${botToken}/getChat`
  console.log('[Scan:BotAPI] Getting chat info, channelId:', channelId, 'URL:', chatUrl.replace(botToken, '***'))

  const chatAbortController = new AbortController()
  const chatTimeoutId = setTimeout(() => chatAbortController.abort(), FETCH_TIMEOUT_MS)

  let chatResp: Response
  try {
    chatResp = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: channelId }),
      signal: chatAbortController.signal,
    })
  } catch (e: any) {
    clearTimeout(chatTimeoutId)
    if (e.name === 'AbortError') {
      console.error('[Scan:BotAPI] getChat timed out, channelId:', channelId)
      throw new Error('获取频道信息超时，Telegram API 未响应')
    }
    throw e
  }
  clearTimeout(chatTimeoutId)

  let chatData: any
  try {
    chatData = await chatResp.json() as any
  } catch (e) {
    console.error('[Scan:BotAPI] getChat response is not valid JSON, channelId:', channelId, 'status:', chatResp.status)
    throw new Error('getChat 返回了非 JSON 响应')
  }
  console.log('[Scan:BotAPI] getChat response ok:', chatData.ok, chatData.ok ? '' : 'error:' + chatData.description)
  if (!chatData.ok) {
    const errorMsg = chatData.description === 'Bad Request: chat not found'
      ? 'Bot 不是该频道管理员，无法通过 Bot API 扫描。请将 Bot 添加为频道管理员，或配置 MTProto 凭证 (api_id + api_hash) 使用 MTProto 扫描。'
      : `getChat 失败: ${chatData.description}`
    return -1
  }

  // ===== 2. 通过 getUpdates 获取频道最近帖子，确定有效消息 ID 范围 =====
  // 确保没有 webhook（getUpdates 和 webhook 互斥）
  const webhookResp = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`)
  const webhookInfo = await webhookResp.json() as any
  if (webhookInfo.ok && webhookInfo.result?.url) {
    console.log('[Scan:BotAPI] Webhook is set, deleting webhook to enable getUpdates')
    await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: false }),
    })
  }

  // 获取频道最近的帖子更新
  const updatesUrl = `https://api.telegram.org/bot${botToken}/getUpdates`
  const updatesResp = await fetch(updatesUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      limit: 100,
      timeout: 0,
      allowed_updates: ['channel_post'],
    }),
  })
  let updatesData: any
  try {
    updatesData = await updatesResp.json() as any
  } catch (e) {
    console.error('[Scan:BotAPI] getUpdates response is not valid JSON')
    throw new Error('getUpdates 返回了非 JSON 响应')
  }

  let latestMessageId = 0  // 频道中已知最新的消息 ID
  let alreadyProcessedIds = new Set<number>()  // getUpdates 已经返回过的消息 ID
  if (updatesData.ok && updatesData.result?.length > 0) {
    for (const update of updatesData.result) {
      if (update.channel_post) {
        const msgId = update.channel_post.message_id
        if (msgId > latestMessageId) latestMessageId = msgId
        alreadyProcessedIds.add(msgId)
      }
    }
    console.log('[Scan:BotAPI] getUpdates found latest messageId:', latestMessageId, 'from', updatesData.result.length, 'updates')
  } else {
    console.log('[Scan:BotAPI] getUpdates returned no updates')
  }

  // 如果 getUpdates 没有返回任何更新，且 lastMessageId 为 0，
  // 说明可能是首次扫描但频道没有最近 24 小时内的帖子，或者是频道消息 ID 不连续
  // 此时只能尝试从 lastMessageId + 1 开始向后扫描
  if (latestMessageId === 0) {
    latestMessageId = lastMessageId + 1
  }

  // ===== 3. 先处理 getUpdates 返回的消息（避免重复 forwardMessage） =====
  if (alreadyProcessedIds.size > 0) {
    console.log('[Scan:BotAPI] Processing', alreadyProcessedIds.size, 'messages from getUpdates')
    for (const msgId of alreadyProcessedIds) {
      if (msgId <= lastMessageId) continue  // 跳过已扫描的消息

      // 从 getUpdates 的结果中找到对应的 channel_post
      const update = updatesData.result.find((u: any) => u.channel_post?.message_id === msgId)
      if (!update?.channel_post) continue

      const channelPost = update.channel_post
      await handleMessage(channelPost, msgId)
      // getUpdates 返回的消息不需要 forwardMessage，也不需要 deleteMessage
    }
  }

  // ===== 4. 向后（递增）扫描 =====
  console.log('[Scan:BotAPI] Scanning forwards from messageId:', latestMessageId)
  let currentMessageId = latestMessageId

  // 如果 latestMessageId 已经在 alreadyProcessedIds 中，跳到下一个
  while (alreadyProcessedIds.has(currentMessageId)) {
    currentMessageId++
  }

  while (true) {
    const result = await doForwardMessage(currentMessageId)

    if (!result) {
      // fetch 超时或 JSON 解析失败，跳过此消息
      currentMessageId++
      continue
    }

    const { fwdData } = result

    if (!fwdData.ok) {
      // 区分不同的错误类型
      if (fwdData.error_code === 400) {
        const desc = fwdData.description || ''
        if (desc.includes('MESSAGE_ID_INVALID') || desc.includes('message to forward not found')) {
          // 消息 ID 不存在或无法转发，说明到达了消息边界
          // 注意：Telegram 频道消息 ID 可能不连续，"message to forward not found" 也表示消息不存在
          console.log('[Scan:BotAPI] Message ID does not exist or not forwardable, reached boundary. messageId:', currentMessageId, 'description:', desc)
          break
        }
        // 其他 400 错误（如消息过大等），跳过此消息继续扫描
        console.warn('[Scan:BotAPI] forwardMessage 400 error, skipping. messageId:', currentMessageId, 'description:', desc)
        currentMessageId++
        continue
      }
      if (fwdData.error_code === 404) {
        console.log('[Scan:BotAPI] Message not found (404), reached boundary. messageId:', currentMessageId)
        break
      }
      throw new Error(`forwardMessage failed: ${fwdData.description}`)
    }

    const msg = fwdData.result
    await handleMessage(msg, currentMessageId)

    // 删除转发到 bot 自身的消息
    await deleteForwardedMessage(msg.message_id)

    currentMessageId++
  }

  // ===== 5. 向前（递减）扫描旧消息 =====
  // 只有当 lastMessageId < latestMessageId - 1 时才需要
  if (lastMessageId < latestMessageId - 1) {
    console.log('[Scan:BotAPI] Scanning backwards from messageId:', latestMessageId - 1, 'to', lastMessageId + 1)
    let backMessageId = latestMessageId - 1

    // 跳过 alreadyProcessedIds 中的消息
    while (backMessageId > lastMessageId && alreadyProcessedIds.has(backMessageId)) {
      backMessageId--
    }

    while (backMessageId > lastMessageId) {
      const result = await doForwardMessage(backMessageId)

      if (!result) {
        // fetch 超时或 JSON 解析失败，跳过此消息
        backMessageId--
        continue
      }

      const { fwdData } = result

      if (!fwdData.ok) {
        if (fwdData.error_code === 400) {
          const desc = fwdData.description || ''
          if (desc.includes('MESSAGE_ID_INVALID') || desc.includes('message to forward not found')) {
            console.log('[Scan:BotAPI] Message ID does not exist or not forwardable (backwards), reached boundary. messageId:', backMessageId)
            break
          }
          console.warn('[Scan:BotAPI] forwardMessage 400 error (backwards), skipping. messageId:', backMessageId, 'description:', desc)
        } else if (fwdData.error_code === 404) {
          console.log('[Scan:BotAPI] Message not found (backwards), reached boundary. messageId:', backMessageId)
          break
        } else {
          console.warn('[Scan:BotAPI] forwardMessage failed (backwards), messageId:', backMessageId, 'error:', fwdData.description)
          break
        }
        backMessageId--
        continue
      }

      const msg = fwdData.result
      await handleMessage(msg, backMessageId)

      // 删除转发到 bot 自身的消息
      await deleteForwardedMessage(msg.message_id)

      backMessageId--

      // 跳过 alreadyProcessedIds 中的消息
      while (backMessageId > lastMessageId && alreadyProcessedIds.has(backMessageId)) {
        backMessageId--
      }
    }
  }

  return maxNewMessageId
}

// ===== DO WebSocket 代理扫描（用于只有 api_id + api_hash 的来源） =====

/**
 * 通过 Durable Object WebSocket 代理连接 MTProto 扫描频道
 * 使用 @mtcute/web 的 TelegramClient，通过 DO 代理 WebSocket
 */
async function scanChannelViaDOProxy(
  env: Env,
  source: Source,
  db: D1Database,
  sourceId: number,
  channelId: string,
  sourceType: string,
  lastMessageId: number,
  onProgress: (p: { processed: number; current_file: string; message_id: number; done: boolean; error?: string }) => Promise<void>,
): Promise<number> {
  console.log('[Scan:DOProxy] Starting scan, sourceId:', sourceId, 'channelId:', channelId, 'sourceType:', sourceType, 'lastMessageId:', lastMessageId)

  // 使用 @mtcute/web 创建 TelegramClient，替换 transport 为 DO 代理
  const { TelegramClient, MemoryStorage, WebCryptoProvider } = await import('@mtcute/web')

  const sessionKey = `session:${source.id}`
  const sessionStr = source.session_string || (await env.KV.get(sessionKey)) || undefined
  console.log('[Scan:DOProxy] Session key:', sessionKey, 'hasSessionString:', !!source.session_string, 'hasKVSession:', !!(await env.KV.get(sessionKey)))
  // 修复 @mtcute/core EarlyTimer 无限递归导致栈溢出的问题
  await patchEarlyTimer()


  // 创建自定义 transport：DOProxyTransport 会根据 DC 参数动态创建 WS 代理连接
  const doProxyTransport = new DOProxyTransport(env)

  // CF Workers 原生支持 WASM 模块导入，
  // 这里直接使用顶部导入的 WASM Module，
  // 传给 WebCryptoProvider 的 wasmInput 参数，绕过 getWasmUrl() 的 URL 构建问题。
  const wasmModule = getMtcuteWasmModule()
  console.log('[Scan:DOProxy] WASM module loaded via Workers native import')

  const storage = new MemoryStorage()
  const clientConfig = {
    apiId: Number(source.api_id),
    apiHash: source.api_hash!,
    storage,
    crypto: new WebCryptoProvider({ wasmInput: wasmModule }),
    transport: doProxyTransport as any,
    disableUpdates: true,
  }
  console.log('[Scan:DOProxy] Creating TelegramClient, apiId:', source.api_id, 'apiHash:', source.api_hash ? '***set***' : '***missing***')
  const client = new TelegramClient(clientConfig)

  // 连接 MTProto（通过 DO 代理的 WebSocket）
  console.log('[Scan:DOProxy] Starting MTProto client with session:', sessionStr ? 'existing' : 'none')
  await client.start({ session: sessionStr })
  console.log('[Scan:DOProxy] MTProto client started successfully')

  // 保存 session 到 KV（同时也存在 D1 的 session_string 字段中）
  const exported = await client.exportSession()
  if (exported) {
    await env.KV.put(sessionKey, exported as string)
    // 持久化到 D1 数据库
    await updateSourceSession(db, sourceId, exported)
  }

  // 扫描频道消息
  // 构建 inputPeerChannel 以正确解析 peer（避免 MtPeerNotFoundError 或卡住）
  // channel_id 在数据库中以 "-100XXXXXXXXXX" 格式存储，
  // 需要去掉 "-100" 前缀得到 bare channel id。
  const channelIdStr = String(channelId)
  let bareChannelId: number
  if (channelIdStr.startsWith('-100')) {
    bareChannelId = Number(channelIdStr.slice(4))
  } else if (channelIdStr.startsWith('-')) {
    bareChannelId = Number(channelIdStr.slice(1))
  } else {
    bareChannelId = Number(channelIdStr)
  }
  console.log('[Scan:DOProxy] Resolved bareChannelId:', bareChannelId, 'from channelId:', channelId)

  // 使用 resolveChannel 自动获取 accessHash
  // 传入 bareChannelId（number），mtcute 会自动从 storage/server 查找 channel 信息
  let channelAccessHash: bigint = 0n
  let inputPeer: { _: 'inputPeerChannel'; channelId: number; accessHash: bigint }
  try {
    const inputChannel = await client.resolveChannel(bareChannelId)
    // resolveChannel 返回的 inputChannel 包含正确的 accessHash
    channelAccessHash = (inputChannel as any).accessHash
    inputPeer = {
      _: 'inputPeerChannel',
      channelId: bareChannelId,
      accessHash: channelAccessHash,
    }
    console.log('[Scan:DOProxy] Resolved channel accessHash successfully via resolveChannel')
  } catch (e) {
    console.warn('[Scan:DOProxy] Failed to resolve channel via resolveChannel, trying channels.getChannels fallback:', e)
    try {
      const resolved = await client.call({
        _: 'channels.getChannels',
        id: [{
          _: 'inputChannel',
          channelId: bareChannelId,
          accessHash: 0n as any,
        }],
      } as any)
      if (resolved._ === 'messages.chats' || resolved._ === 'messages.chatsSlice') {
        const ch = resolved.chats[0]
        if (ch && 'accessHash' in ch) {
          channelAccessHash = ch.accessHash
          console.log('[Scan:DOProxy] Resolved channel accessHash successfully via getChannels fallback')
        }
      }
    } catch (e2) {
      console.warn('[Scan:DOProxy] Failed to resolve channel accessHash with all methods:', e2)
    }
    inputPeer = {
      _: 'inputPeerChannel',
      channelId: bareChannelId,
      accessHash: channelAccessHash,
    }
  }

  if (channelAccessHash === 0n) {
    throw new Error('无法获取频道 accessHash，请确保 session 有效且有权限访问该频道')
  }

  let maxNewMessageId = lastMessageId
  let processed = 0
  let offsetId: number | undefined
  let offsetDate: number | undefined

  while (true) {
    const messages = await client.getHistory(inputPeer, {
      limit: 100,
      ...(offsetId !== undefined && offsetDate !== undefined
        ? { offset: { id: offsetId, date: offsetDate } }
        : {}),
    })

    if (!messages || messages.length === 0) break

    let reachedOld = false
    for (const msg of messages) {
      if (msg.id <= lastMessageId) { reachedOld = true; break }
      if (msg.id > maxNewMessageId) maxNewMessageId = msg.id

      const media = msg.media
      if (!media) continue

      let fileName = ''
      let fileSize = 0
      let mimeType = ''
      let fileUniqueId = ''

      if (media.type === 'document' || media.type === 'video' || media.type === 'audio' || media.type === 'voice') {
        const doc = media as any
        fileSize = doc.fileSize ?? doc.raw?.size ?? 0
        mimeType = doc.mimeType ?? ''
        fileUniqueId = String(doc.raw?.id ?? doc.raw?.accessHash ?? msg.id)
        fileName = doc.fileName ?? `${media.type}_${msg.id}`
      } else if (media.type === 'photo') {
        const photo = media as any
        mimeType = 'image/jpeg'
        fileUniqueId = String(photo.raw?.id ?? msg.id)
        fileName = `photo_${msg.id}.jpg`
      } else {
        continue
      }

      const mediaType = detectMediaType(mimeType, sourceType)
      const fileHash = await computeFileHash(fileName, fileSize, mimeType, fileUniqueId)
      const nameRegex = source.name_regex
      const parsed = nameRegex
        ? extractNameWithRegex(fileName, nameRegex)
        : extractNameAndTags(fileName)

      await upsertMediaItem(db, {
        source_id: sourceId,
        message_id: msg.id,
        file_name: fileName,
        file_size: fileSize,
        mime_type: mimeType || null,
        media_type: mediaType,
        file_hash: fileHash,
        message_date: Math.floor(msg.date.getTime() / 1000),
        title: parsed.name, description: null, cover: null,
        release_date: null, rating: null, genre: null,
        external_id: null, scraped_at: null,
tags: parsed.tags.length > 0 ? parsed.tags.join(',') : null,
      })

      processed++
      await onProgress({ processed, current_file: fileName, message_id: msg.id, done: false })
    }

    if (reachedOld || messages.length < 100) break
    const last = messages[messages.length - 1]
    offsetId = last.id
    offsetDate = Math.floor(last.date.getTime() / 1000)
  }

  await client.disconnect()
  return maxNewMessageId
}

// ===== 媒体类型检测 =====
function detectMediaType(mimeType: string | undefined, sourceType: string): string {
  if (!mimeType) return sourceType
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('image/')) return 'image'
  if (['application/pdf', 'application/epub+zip', 'application/x-mobipocket-ebook'].includes(mimeType)) return 'book'
  return sourceType
}

// ===== SSE 扫描路由 =====
export interface ScanProgress {
  processed: number
  current_file: string
  message_id: number
  done: boolean
  error?: string
}

export type ProgressCallback = (p: ScanProgress) => Promise<void>

app.get('/:id/scan', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400)
  const source = await getSourceById(c.env.DB, id)
  if (!source) return c.json({ error: '来源不存在' }, 404)

  console.log('[Scan] Starting scan for source:', id, 'scan_mode:', source.scan_mode, 'bot_token:', source.bot_token ? '***set***' : 'none', 'api_id:', source.api_id, 'api_hash:', source.api_hash ? '***set***' : 'none', 'channel_id:', source.channel_id, 'last_scan_message_id:', source.last_scan_message_id)

  // 判断扫描模式：根据 scan_mode 选择扫描方式
  // scan_mode 为必填，值：simple_bot_api、bot_api、mtproto
  const scanMode = source.scan_mode
  if (!scanMode || scanMode === 'auto') {
    return c.json({ error: '该来源未设置扫描模式，请编辑来源并选择一个具体的扫描模式' }, 400)
  }

  // 检查是否有必要的凭证
  const hasMTProto = !!(source.api_id && source.api_hash)
  const hasBotToken = !!source.bot_token

  if (!hasMTProto && !hasBotToken) {
    return c.json({ error: '该来源未配置扫描凭证 (需要 bot_token 或 api_id/api_hash)' }, 400)
  }

  // 返回 SSE
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')

  return stream(c, async (s) => {
    const send = async (data: object) => {
      await s.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    try {
      let maxId: number

      // 根据 scan_mode 选择扫描方式
      if (scanMode === 'mtproto') {
        console.log('[Scan] Using MTProto via DO Proxy')
        if (!source.api_id || !source.api_hash) {
          throw new Error('MTProto 模式需要配置 api_id 和 api_hash')
        }
        maxId = await scanChannelViaDOProxy(
          c.env,
          source,
          c.env.DB,
          source.id,
          source.channel_id,
          source.type,
          source.last_scan_message_id,
          async (p) => { await send(p) },
        )
      } else if (scanMode === 'simple_bot_api') {
        console.log('[Scan] Using Simple Bot API (getUpdates)')
        if (!source.bot_token) {
          throw new Error('Simple Bot API 模式需要配置 bot_token')
        }
        maxId = await scanChannelViaSimpleBotAPI(
          source.bot_token!,
          c.env.DB,
          source.id,
          source.channel_id,
          source.type,
          source.last_scan_message_id,
          source.name_regex,
          async (p) => { await send(p) },
        )
      } else if (scanMode === 'bot_api') {
        console.log('[Scan] Using Bot API (forwardMessage)')
        if (!source.bot_token) {
          throw new Error('Bot API 模式需要配置 bot_token')
        }
        maxId = await scanChannelViaBotAPI(
          source.bot_token!,
          c.env.DB,
          source.id,
          source.channel_id,
          source.type,
          source.last_scan_message_id,
          source.name_regex,
          async (p) => { await send(p) },
        )
      } else {
        throw new Error(`不支持的扫描模式: ${scanMode}`)
      }

      if (maxId > source.last_scan_message_id && maxId !== -1) {
        await c.env.DB.prepare(
          'UPDATE sources SET last_scan_message_id = ?, last_scan_at = ? WHERE id = ?'
        ).bind(maxId, Math.floor(Date.now() / 1000), id).run()
      }
      if (maxId === -1) {
        await send({ done: true, error: 'Bot 不是该频道管理员，无法通过 Bot API 扫描。请将 Bot 添加为频道管理员，或配置 MTProto 凭证 (api_id + api_hash) 使用 MTProto 扫描。' })
      } else {
        await send({ done: true, processed: maxId })
      }
    } catch (e: unknown) {
      console.error('[Scan] Scan failed with error:', e instanceof Error ? e.message : String(e), e instanceof Error ? e.stack : '')
      await send({ done: true, error: String(e) })
    }
  })
})

// ===== Session 生成端点 =====
// 在 Worker 中交互式生成 mtcute session，通过 SSE 实时返回进度
// 生成的 session 持久化到 D1（sources.session_string）和 KV（session:sourceId）

app.post('/:id/generate-session', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400)
  const source = await getSourceById(c.env.DB, id)
  if (!source) return c.json({ error: '来源不存在' }, 404)

  if (!source.api_id || !source.api_hash) {
    return c.json({ error: '该来源未配置 api_id / api_hash，无法生成 session' }, 400)
  }

  // 返回 SSE
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')

  return stream(c, async (s) => {
    const send = async (data: object) => {
      await s.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    try {
      await send({ step: 'connecting', message: '正在建立 WebSocket 代理连接...' })

      console.log('[GenSession] Setting up DOProxy transport for source:', id)

      // DOProxyTransport 会根据 DC 参数动态创建 WS 代理连接
      // 不再需要预先创建 WS 代理连接

      await send({ step: 'connected', message: 'Transport 已就绪' })

      // 导入 @mtcute/web
      const { TelegramClient, MemoryStorage, WebCryptoProvider } = await import('@mtcute/web')
      // 修复 @mtcute/core EarlyTimer 无限递归导致栈溢出的问题
      await patchEarlyTimer()


      // 创建自定义 transport：DOProxyTransport 会根据 DC 参数动态创建 WS 代理连接
      const doProxyTransport = new DOProxyTransport(c.env)

      // CF Workers 原生 WASM 模块导入
      const wasmModule = getMtcuteWasmModule()
      console.log('[GenSession] WASM module loaded via Workers native import')

      const storage = new MemoryStorage()

      const client = new TelegramClient({
        apiId: Number(source.api_id),
        apiHash: source.api_hash!,
        storage,
        crypto: new WebCryptoProvider({ wasmInput: wasmModule }),
        transport: doProxyTransport as any,
        disableUpdates: true,
      })

      await send({ step: 'login_phone', message: '请输入手机号（国际格式，如 +8613800138000）' })

      // 交互式登录：通过 SSE 接收用户输入
      const phone = await waitForInput(s, 'phone')

      await send({ step: 'login_code', message: '请输入 Telegram 发送的验证码' })
      const code = await waitForInput(s, 'code')

      // 尝试登录，可能需要两步验证密码
      let needPassword = false
      try {
        await client.start({
          phone: () => phone,
          code: () => code,
          password: () => {
            needPassword = true
            return ''
          },
        })
      } catch (e: any) {
        // 如果是因为没有提供密码导致的错误，提示输入密码
        if (e.message?.includes('password') || e.message?.includes('2FA')) {
          needPassword = true
        } else {
          throw e
        }
      }

      if (needPassword) {
        await send({ step: 'login_password', message: '该账号启用了两步验证，请输入密码' })
        const password = await waitForInput(s, 'password')

        await client.start({
          phone: () => phone,
          code: () => code,
          password: () => password,
        })
      }

      await send({ step: 'login_success', message: '登录成功！' })

      // 导出 session
      const session = await client.exportSession()
      console.log('[GenSession] Session exported for source:', id, 'session length:', session?.length)

      // 持久化到 D1 和 KV
      if (session) {
        const sessionKey = `session:${id}`
        await c.env.KV.put(sessionKey, session)
        await updateSourceSession(c.env.DB, id, session)
        console.log('[GenSession] Session saved to KV:', sessionKey, 'and D1')
      }

      await send({ step: 'done', session, message: 'Session 生成成功！已保存到数据库。' })

      await client.disconnect()
    } catch (e: unknown) {
      console.error('[GenSession] Session generation failed:', e instanceof Error ? e.message : String(e), e instanceof Error ? e.stack : '')
      await send({ step: 'error', error: String(e) })
    }
  })
})

// 等待客户端通过 SSE 发送的输入
// 前端通过发送 JSON 格式的消息：{ "type": "input", "inputType": "phone"|"code"|"password", "value": "..." }
async function waitForInput(s: any, inputType: string): Promise<string> {
  return new Promise((resolve) => {
    const handler = async (chunk: any) => {
      try {
        const data = JSON.parse(chunk.toString())
        if (data.type === 'input' && data.inputType === inputType) {
          // 移除监听器
          s.removeListener('data', handler)
          resolve(data.value)
        }
      } catch {
        // 忽略无法解析的消息
      }
    }
    s.on('data', handler)
  })
}

export default app