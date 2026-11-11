-- 0040_doubao_support_15s.sql
-- 豆包 Seedance 已对非会员开放 15s 档位（网页实测可手动拖到 15s）。
-- 放开 providers.capabilities.supported_durations 到 [5,10,15]，
-- 让分镜编排 / 生成页可提交 15s（此前 0012 迁移仅配置 [5,10]）。
UPDATE providers
SET capabilities = COALESCE(capabilities, '{}'::jsonb) || '{"supported_durations":[5,10,15]}'::jsonb
WHERE id = 'doubao';
