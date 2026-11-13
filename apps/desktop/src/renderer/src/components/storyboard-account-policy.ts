interface StoryboardAccountBinding {
  keyId: string
  accountName: string
  remaining: number
  health: string
}

export function buildStoryboardAccountOption(binding: StoryboardAccountBinding): {
  value: string
  label: string
  disabled: boolean
} {
  const healthLabel =
    binding.health === 'expired'
      ? '｜待网页验证'
      : binding.health === 'expiring'
        ? '｜即将过期'
        : ''
  return {
    value: binding.keyId,
    label: `${binding.accountName}（剩 ${binding.remaining}秒）${healthLabel}`,
    disabled: false
  }
}
