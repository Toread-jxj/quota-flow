const CONFIRM_REQUEST = /确认后我再开始生成视频|我将按最终要求生成|视频生成参数确认|确认以上参数|请确认以上方案/

export function hasConfirmRequestAfterPrompt(pageText: string, promptAnchor: string): boolean {
  if (!promptAnchor) return false
  const promptIndex = pageText.lastIndexOf(promptAnchor)
  if (promptIndex < 0) return false
  return CONFIRM_REQUEST.test(pageText.slice(promptIndex + promptAnchor.length))
}
