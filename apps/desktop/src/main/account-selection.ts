export function findNextProviderAccount<T extends { id: string }>(
  accounts: T[],
  tried: ReadonlySet<string>,
  remainingOf: (accountId: string) => number,
  cost: number,
  preferredAccountId?: string | null
): T | undefined {
  return accounts.find(
    (account) =>
      !tried.has(account.id) &&
      (preferredAccountId === account.id || remainingOf(account.id) >= cost)
  )
}
