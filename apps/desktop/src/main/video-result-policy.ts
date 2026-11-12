export type VideoCandidate = { src: string; poster?: string }
export type NewVideoResult = { videoUrl: string; posterUrl?: string | null }

/** baseline 未确认时 fail-closed，禁止把历史视频误认作本次结果。 */
export function pickNewVideoResult(
  baselineReady: boolean,
  baseline: Set<string>,
  videos: VideoCandidate[] = [],
  mp4s: string[] = []
): NewVideoResult | null {
  if (!baselineReady) return null
  const video = videos.find((candidate) => candidate.src && !baseline.has(candidate.src))
  if (video?.src) return { videoUrl: video.src, posterUrl: video.poster || null }
  const mp4 = mp4s.find((candidate) => candidate && !baseline.has(candidate))
  return mp4 ? { videoUrl: mp4 } : null
}
