export type DoubaoRequestKind = 'upload' | 'submit' | 'other'

export type DoubaoNetworkObservation = {
  kind: DoubaoRequestKind
  epoch: number
  status?: number | null
  transportError?: boolean
}

export type DoubaoNetworkFailure = {
  kind: Exclude<DoubaoRequestKind, 'other'>
  status: number | null
  transportError: boolean
}

export function summarizeDoubaoNetworkFailures(
  observations: DoubaoNetworkObservation[],
  scope?: { kind: 'upload' | 'submit'; epoch: number }
): DoubaoNetworkFailure[] {
  return observations
    .filter((item): item is DoubaoNetworkObservation & { kind: 'upload' | 'submit' } =>
      item.kind !== 'other' &&
      (!scope || (item.kind === scope.kind && item.epoch === scope.epoch)) &&
      (item.transportError === true || (typeof item.status === 'number' && item.status >= 400))
    )
    .map((item) => ({
      kind: item.kind,
      status: typeof item.status === 'number' ? item.status : null,
      transportError: item.transportError === true
    }))
}
