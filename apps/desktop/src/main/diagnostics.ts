import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const KEEP_LOG_BYTES = 1 * 1024 * 1024

function logPath(): string {
  return join(app.getPath('userData'), 'qf-generation.log')
}

function trimLogIfNeeded(file: string): void {
  try {
    if (statSync(file).size <= MAX_LOG_BYTES) return
    const data = readFileSync(file)
    writeFileSync(file, data.subarray(Math.max(0, data.length - KEEP_LOG_BYTES)))
  } catch {}
}

function redactText(value: string): string {
  return value
    .replace(/(access_token|refresh_token|apikey|api_key|authorization|cookie|set-cookie)\s*[:=]\s*[^\s,}]+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL_REDACTED]')
    .slice(0, 2000)
}

function safeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), stack: value.stack ? redactText(value.stack) : undefined }
  }
  if (typeof value === 'string') return redactText(value)
  if (value && typeof value === 'object') {
    try {
      const normalized = JSON.parse(JSON.stringify(value, (key, val) => /token|secret|key|cookie|encrypted/i.test(key) ? '[REDACTED]' : val))
      return JSON.parse(redactText(JSON.stringify(normalized)))
    } catch { return '[UNSERIALIZABLE]' }
  }
  return value
}

export function logGeneration(event: string, data?: unknown): void {
  try {
    const file = logPath()
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      data: safeValue(data)
    }) + '\n'
    appendFileSync(file, line, 'utf8')
    trimLogIfNeeded(file)
  } catch (error) {
    console.error('[qf-generation-log] write failed:', error)
  }
}

export function generationLogPath(): string {
  return logPath()
}
