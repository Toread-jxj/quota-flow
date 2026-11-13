export interface StoryboardRecoveryQuotaInput {
  jobId: string
  userId: string
  providerId: string
  costAmount: number
  keyId: string | null
  teamId: string | null
  date: string
}

export interface StoryboardRecoveryQuotaRequest {
  rpcName: 'reconcile_consume_and_finalize' | 'team_consume_quota_and_finalize'
  rpcArgs: Record<string, string | number | null>
}

export function quotaDateForJob(createdAt: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(createdAt))
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

export function buildStoryboardRecoveryQuotaRequest(input: StoryboardRecoveryQuotaInput): StoryboardRecoveryQuotaRequest {
  if (!input.jobId || !input.userId || !input.providerId || input.costAmount <= 0) {
    throw new Error('补下载任务缺少有效额度信息')
  }
  if (input.teamId) {
    return {
      rpcName: 'team_consume_quota_and_finalize',
      rpcArgs: {
        p_team_id: input.teamId,
        p_user_id: input.userId,
        p_provider_id: input.providerId,
        p_amount: input.costAmount,
        p_account_key_id: input.keyId,
        p_date: input.date,
        p_job_id: input.jobId
      }
    }
  }
  return {
    rpcName: 'reconcile_consume_and_finalize',
    rpcArgs: {
      p_user_id: input.userId,
      p_provider_id: input.providerId,
      p_amount: input.costAmount,
      p_key_id: input.keyId,
      p_date: input.date,
      p_job_id: input.jobId
    }
  }
}
