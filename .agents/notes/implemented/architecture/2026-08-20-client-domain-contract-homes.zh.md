# Agent Note: 客户端领域约定归属

[English](2026-08-20-client-domain-contract-homes.md) | 中文

Status: implemented

## Problem

rc.8 客户端源码存在兄弟实现目录之间的 import，以及从 `contract/` 反向指向实现的 import。二十六条依赖边中有二十五条来自上游源码，一条来自下游 conversation slot 合并。客户端领域图门禁会依据 [GUI 客户端架构](2026-07-19-gui-web-client-architecture.md)确立的分层规则拒绝全部依赖边；若把这些失败视为仅属于下游的合并噪声，交付源码就会继续与其强制架构不一致。

## Decision

跨领域类型位于各包的 `contract/` 目录。被多个领域使用的纯模块位于包内 `src/client/` 顶层，并且只依赖包级模块或约定。领域实现目录只 import 约定与顶层共享模块，不 import 兄弟实现。`apply.ts` 仍是唯一的跨领域组装点。

运行时约定持有公开的 Session 与 Workspace 列表类型。Agent scope、conversation snapshot 值、待处理交互值、上下文来源信息和通知调度位于运行时顶层共享模块。`ui-conversation` 中，输入约定与编辑器阻塞接口属于约定，引用图标、指标、工具节点读取器、装饰派生、队列投影和共享统计属于顶层纯 helper。`ui-workspace` 将行组件放在浏览器 owner 旁，因为这些行属于展示部件，而不是可独立组合的领域。

`scripts/verify-client-domain-graph.ts` 保持严格，不携带包级 allowlist 或既有依赖边基线。

## Verification

领域图门禁扫描完整客户端源码树。客户端 TypeScript 程序验证全部移动后的 import 与公开导出，runtime、conversation 和 workspace 包测试则通过现有公开表层覆盖受影响实现。

## Alternatives considered

**为 rc.8 依赖边添加 allowlist。** 否决，因为这会把当前源码布局变成规则例外，而同一规则本应阻止未来的所有权漂移。

**在原实现路径增加转发模块。** 否决，因为仓库不存在已发布的兼容义务；转发会保留重复归属，也不会移除违规依赖。

**立即把每个领域拆为独立包。** 否决，因为确立正确的包内归属已经解决依赖问题；没有独立演进需要时，拆包只会增加部署与 loader 表层。

## Consequences

门禁与交付源码现在描述相同的依赖方向。共享值只有一个权威归属，包内组合保持显式。文件移动会改变内部源码 import 路径，但公开包导出与运行时行为不变。
