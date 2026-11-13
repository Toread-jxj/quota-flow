interface PromptShot {
  index: number
  prompt: string
}

export function initializePromptDrafts(shots: PromptShot[]): Record<number, string> {
  return Object.fromEntries(shots.map((shot) => [shot.index, shot.prompt]))
}

export function updatePromptDraft(
  drafts: Record<number, string>,
  index: number,
  prompt: string
): Record<number, string> {
  return { ...drafts, [index]: prompt }
}

export function promptForGeneration(shot: PromptShot, drafts: Record<number, string>): string {
  return drafts[shot.index] ?? shot.prompt
}
