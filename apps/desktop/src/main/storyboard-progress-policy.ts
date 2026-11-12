const STRING_FIELDS = ['jobId', 'remoteUrl', 'videoPath', 'status', 'accountId'] as const

export function validateStoryboardProgressRoot(value: unknown): { ok: boolean; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: '进度文件顶层必须是对象' }
  }
  const shots = (value as { shots?: unknown }).shots
  if (shots === undefined) return { ok: true }
  if (!shots || typeof shots !== 'object' || Array.isArray(shots)) {
    return { ok: false, error: '进度文件 shots 必须是对象' }
  }
  for (const [index, rawEntry] of Object.entries(shots)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      return { ok: false, error: `进度文件 shot ${index} 必须是对象` }
    }
    const entry = rawEntry as Record<string, unknown>
    for (const field of STRING_FIELDS) {
      const fieldValue = entry[field]
      if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== 'string') {
        return { ok: false, error: `进度文件 shot ${index}.${field} 必须是字符串或空值` }
      }
    }
  }
  return { ok: true }
}
