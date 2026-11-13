import { describe, expect, it } from 'vitest'
import { buildStoryboardRecoveryQuotaRequest, quotaDateForJob } from './storyboard-recovery-policy'

describe('buildStoryboardRecoveryQuotaRequest', () => {
  it('个人自动选号任务补下载后使用幂等 RPC 追记额度', () => {
    expect(buildStoryboardRecoveryQuotaRequest({
      jobId: 'job-1',
      userId: 'user-1',
      providerId: 'doubao',
      costAmount: 15,
      keyId: 'key-1',
      teamId: null,
      date: '2026-11-12'
    })).toEqual({
      rpcName: 'reconcile_consume_and_finalize',
      rpcArgs: {
        p_user_id: 'user-1',
        p_provider_id: 'doubao',
        p_amount: 15,
        p_key_id: 'key-1',
        p_date: '2026-11-12',
        p_job_id: 'job-1'
      }
    })
  })

  it('团队任务补下载后使用团队原子扣减并保持 job 幂等', () => {
    expect(buildStoryboardRecoveryQuotaRequest({
      jobId: 'job-2',
      userId: 'user-1',
      providerId: 'doubao',
      costAmount: 10,
      keyId: 'key-2',
      teamId: 'team-1',
      date: '2026-11-12'
    })).toEqual({
      rpcName: 'team_consume_quota_and_finalize',
      rpcArgs: {
        p_team_id: 'team-1',
        p_user_id: 'user-1',
        p_provider_id: 'doubao',
        p_amount: 10,
        p_account_key_id: 'key-2',
        p_date: '2026-11-12',
        p_job_id: 'job-2'
      }
    })
  })

  it('缺少有效 job 或额度时拒绝伪造扣减请求', () => {
    expect(() => buildStoryboardRecoveryQuotaRequest({
      jobId: '',
      userId: 'user-1',
      providerId: 'doubao',
      costAmount: 0,
      keyId: null,
      teamId: null,
      date: '2026-11-12'
    })).toThrow('补下载任务缺少有效额度信息')
  })

  it('按北京时间还原原 job 的额度日期', () => {
    expect(quotaDateForJob('2026-11-12T16:30:00.000Z')).toBe('2026-11-13')
  })
})
