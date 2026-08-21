# Agent Note: 运行时闭包分离部署与 preset 解析

Status: implemented

[English](2026-08-20-runtime-closure-separate-preset-resolution.md) | 中文

## 问题

可执行程序部署需要两项完整的依赖事实：部署根目录必须满足打包图中所有可达的必需 workspace peer，而用于解析随附 agent preset 的 manifest 必须直接声明这些 preset 可以加载的每个 bare plugin。[Python single-exe 运行时](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md)由一份纯依赖 manifest 同时承担两项职责；DSH-GUI 则从桌面应用 manifest 部署，并相对于桌面组合 bundle 解析 bare plugin 名称。若假定两项事实始终由同一 manifest 承担，就会误报缺失项，或者诱使实现维护一份重复的插件清单。

## 决策

`verifyRuntimeClosure()` 接受部署 manifest、preset resolver manifest 与目标清单的路径。resolver 默认采用部署 manifest，目标清单默认采用 Python 平台 manifest，从而保留 Python 运行时现有的依赖来源与目标列表。workspace peer 遍历始终从部署 manifest 开始。独立 resolver 本身必须可从该图到达；随附 preset 检查随后读取其直接依赖，并针对每个受支持目标求值平台条件。DSH-GUI 将应用 manifest 作为部署根目录，将 `@acosmi/dsh-desktop-bundle` 作为 preset resolver，并将其 release support matrix 作为目标清单。应用 manifest 直接声明其打包图所需的全部必需 workspace peer。

## 曾考虑的替代方案

**在桌面应用 manifest 中重复列出每个 preset 插件。** 桌面 utility 相对于桌面 bundle 解析 bare plugin。在应用中复制该依赖清单会形成第二份可能漂移的列表，却不会改变运行时解析过程。

**对非 Python 部署根目录跳过 preset 校验。** 桌面包会携带同一组 preset 文件，其 resolver 缺少插件时仍可能在运行时失败。省略检查只会把 manifest 模型错误换成安装后产品故障。

**把传递依赖视为满足必需 workspace peer。** pnpm 布局和提升关系不是 peer dependency 声明。部署根目录继续显式列出必需 peer，避免隔离部署依赖偶然的包位置。

## 后果

可复用检查器保留单一严格且连通的部署图，同时让 bare plugin 解析与受支持平台的所有权留在实际 manifest 中。Python 调用方无需传入选项。部署、preset resolver 或目标清单不同的可执行程序必须显式传入这些路径，其打包文档也必须标明各自的来源。
