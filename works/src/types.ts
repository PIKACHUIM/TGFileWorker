export interface Env {
  DB: D1Database
  KV: KVNamespace
  WS_PROXY: DurableObjectNamespace
  SESSION_GEN: DurableObjectNamespace
  TG_CLIENT: DurableObjectNamespace
  ASSETS: Fetcher
  JWT_SECRET: string
  WORKER_URL: string
  HASH_LENGTH: string
  RESEND_API_KEY?: string
  [key: string]: unknown
}
