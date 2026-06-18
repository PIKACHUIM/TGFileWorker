import type { Env } from '../types'

/**
 * 使用 Resend API 发送邮件
 * 文档：https://resend.com/docs/api-reference/emails/send-email
 */
export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  html: string
): Promise<{ success: boolean; error?: string }> {
  const apiKey = await getResendApiKey(env)
  const fromEmail = await getResendFromEmail(env)

  if (!apiKey) {
    return { success: false, error: '未配置 Resend API Key' }
  }
  if (!fromEmail) {
    return { success: false, error: '未配置发送邮箱地址' }
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to,
        subject,
        html,
      }),
    })

    if (!resp.ok) {
      const body = await resp.text()
      return { success: false, error: `Resend API 错误: ${body}` }
    }

    return { success: true }
  } catch (e) {
    return { success: false, error: String(e) }
  }
}

/**
 * 发送验证码邮件
 */
export async function sendVerificationCode(
  env: Env,
  to: string,
  code: string
): Promise<{ success: boolean; error?: string }> {
  const domain = await getResendDomain(env)
  const appName = domain ? new URL(domain.startsWith('http') ? domain : `https://${domain}`).hostname : 'Telegram媒体库'

  const html = `
    <div style="max-width:480px;margin:0 auto;padding:32px;font-family:system-ui,-apple-system,sans-serif;">
      <h2 style="color:#1677ff;margin:0 0 24px;">${appName} - 邮箱验证</h2>
      <p style="font-size:16px;color:#333;">您的验证码是：</p>
      <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#1677ff;padding:16px 0;text-align:center;">
        ${code}
      </div>
      <p style="font-size:14px;color:#999;">验证码有效期为 10 分钟，请尽快使用。</p>
      <p style="font-size:12px;color:#bbb;margin-top:32px;">如果这不是您的操作，请忽略此邮件。</p>
    </div>
  `

  return sendEmail(env, to, `${appName} - 邮箱验证码`, html)
}

// ---- 辅助函数 ----

async function getResendApiKey(env: Env): Promise<string | null> {
  // 优先从环境变量读取（通过 wrangler secret put 设置）
  if ((env as Record<string, unknown>).RESEND_API_KEY) {
    return env.RESEND_API_KEY as string
  }
  // 其次从 settings 表读取
  const { getSetting } = await import('../db')
  return getSetting(env.DB, 'resend_api_key')
}

async function getResendFromEmail(env: Env): Promise<string | null> {
  const { getSetting } = await import('../db')
  return getSetting(env.DB, 'resend_from_email')
}

async function getResendDomain(env: Env): Promise<string | null> {
  const { getSetting } = await import('../db')
  return getSetting(env.DB, 'resend_domain')
}
