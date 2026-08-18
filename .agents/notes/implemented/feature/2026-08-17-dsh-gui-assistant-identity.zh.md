# Agent Note: DSH-GUI 助手以 Acosmi 产品身份自我介绍

Status: implemented

[English](2026-08-17-dsh-gui-assistant-identity.md) | 中文

## 问题

桌面组合逐字继承了上游 DeepSeek Harness 的系统提示词，因此助手在每次模型请求的开头都声明「You are an AI agent powered by DeepSeek Harness.」。DSH-GUI 是 Acosmi 的社区发行版，而一个自称上游 DeepSeek 智能体的助手属于随源码复制而来、从未清理过的产品文案。

## 决策

桌面 bundle patch 将 `system-prompt` 行整体替换为 `includeHarnessIdentity: false` 与一条 DSH-GUI 部署 persona：`You are an AI agent in DSH-GUI, Acosmi's desktop AI agent workbench, powered by the {{model}} model. Your working directory is {{cwd}}.`

上游源码层（`packages/core/system-prompt`）保持不变：固定的 harness 身份文本继续供上游 Harness 组合使用。会话的 Agent 预设仍会以自己的 section 遮蔽部署 persona，且随附的预设 persona（standard、code、cordis、minimal）本就不含任何上游品牌文案。

## 备选方案

**保留上游身份行** —— 不采纳。它让助手以 DeepSeek 智能体的身份出现，在用户正阅读的界面里错误标注了社区产品。

**在上游 `system-prompt` 插件内改写品牌** —— 不采纳。`packages/` 是与上游同步的源码层；产品文案应属于下游 bundle patch，修改上游文本会在下一次同步时漂移。

**只移除身份行、不提供替代 persona** —— 不采纳。部署 persona 应当陈述产品身份，而不是仅仅抹去上游身份；作用域内的预设 persona 仍会遮蔽它，因此它不会带来任何约束。

## 后果

桌面助手以 DSH-GUI（Acosmi）的身份自我介绍，而上游 Harness 的 Web 与 CLI 组合保留各自的既有身份。对上游项目的署名仍保留在 README、「关于」免责声明与发行身份信息这些应当存在的位置。

## 验证

桌面组合测试断言了这条 patch 行（`includeHarnessIdentity: false` 加精确的 persona 文本），下游全套测试通过。无密钥 ACP 快照套件不受影响：它们运行的是上游示例组合，仍携带上游身份行。
