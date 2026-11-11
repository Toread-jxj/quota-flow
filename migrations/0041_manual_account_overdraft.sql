-- 手工指定账号：允许突破本地日额度，但仍记录实际使用量。
CREATE OR REPLACE FUNCTION public.atomic_consume_ledger_manual(
  p_user_id UUID,
  p_provider_id TEXT,
  p_amount NUMERIC,
  p_key_id UUID,
  p_date DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE v_row public.quota_ledger%ROWTYPE;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_AMOUNT', 'message', '额度必须大于 0');
  END IF;
  UPDATE public.quota_ledger
  SET used = used + p_amount,
      remaining = GREATEST(daily_total - used - p_amount - reserved, 0),
      refreshed_at = now()
  WHERE date = p_date AND owner_user_id = p_user_id AND provider_id = p_provider_id
    AND account_key_id IS NOT DISTINCT FROM p_key_id AND team_id IS NULL
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'code', 'CONSUMED_MANUAL', 'message', '手工指定账号额度已记录', 'row', row_to_json(v_row)::jsonb);
  END IF;
  RETURN jsonb_build_object('ok', false, 'code', 'LEDGER_NOT_FOUND', 'message', '未找到今日账本行');
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'code', 'DB_ERROR', 'message', SQLERRM);
END;
$$;
GRANT EXECUTE ON FUNCTION public.atomic_consume_ledger_manual(UUID, TEXT, NUMERIC, UUID, DATE) TO authenticated;
