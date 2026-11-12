# Codex 只读审计任务：豆包生成需求与代码一致性

你是独立 Spec Reviewer + Quality Reviewer。禁止修改任何文件，禁止提交。

必须先读：
1. `AGENTS.md`
2. `docs/开发规范/版本需求与回归门禁.md`
3. `docs/桌面端/调度与生成/豆包生成需求事实源.md`
4. 当前 `git diff`
5. `apps/desktop/src/main/webview-engine.ts`
6. `apps/desktop/src/main/dispatch.ts`
7. 新增策略测试与实现文件

使用 Superpowers：systematic-debugging、receiving-code-review、verification-before-completion。

审计合同：
- 只有明确识别到相对提交前 baseline 的本次新增视频 URL 才自动关闭生成窗口；其他情况 show+focus 保留。
- 页面/上传/提交/等待/未知错误不换号。
- 仅明确账号登录态/Cookie/额度耗尽允许自动换号；手工指定永不换号。
- 日志完整记录阶段、账号、partition、上传、提交、baseline、窗口与换号决定，但不泄露 prompt/token/cookie/完整 URL。
- 确认回复是主提示词提交后的豆包二次参数确认，必须使用追加脚本，不得清空上下文。

输出格式：
1. BLOCKERS（文件:行号、触发路径、违反哪条需求）
2. NON-BLOCKERS
3. 需求事实源遗漏或冲突
4. 测试缺口
5. 允许提交/禁止提交

如果无阻塞，明确写“无阻塞问题”。
