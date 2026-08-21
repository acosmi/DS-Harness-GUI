# Agent Note: 桌面 renderer 安装客户端启动前导资源

Status: implemented

[English](2026-08-20-desktop-client-bootstrap-prelude.md) | 中文

## Problem

客户端模块系统通过 page-global facade 创建；该 facade 必须在普通 modules 与 runtime bundle 执行前存在。打包后的桌面文档会直接启动 Vite module，因此 `AppWebEntry` 到达创建点时没有 facade；即使所有 bundle 与完整性记录都已存在，页面仍会显示插件加载失败。

桌面图适配器还会重建每个启动 row 的部分字段。因此，package-specific `external` 请求会在模块系统构造前丢失，桌面顺序也可能与模块图不同。

## Decision

`clientBootAssets()` 是 queue facade 与图中已有 modules-then-runtime parser preload row 的共享 Host 生产方。HTTP shell 在现有策略下以内联方式渲染 facade；桌面构建要求两个 row 都存在，把同一 facade 源码输出为 content-addressed、同源的 classic script，纳入最终资源清单，再把 facade、modules bundle 与 runtime bundle 放到 Vite module 入口之前。最终输出审计会拒绝缺失或乱序的 preload、缺失或已改变的 parser-stage 文件以及任何 inline script，从而保留桌面的 `script-src 'self'` 策略。

桌面组合器会携带 `external` 请求，采用共享模块图排序，并拒绝既没有动态 row 也不由 shell 静态模块表提供的请求。renderer 会在验证可执行 bundle row 及其桌面 URL 后转发原始图；完整 wire 校验仍只由上游 parser 负责。桌面 teardown 会先等待上游 Web 入口异步释放，再撤销 carrier 与图。

## Alternatives considered

**在桌面策略中允许 inline script。** 这会通过削弱打包应用的内容策略来照搬 HTTP 交付机制。由完整性清单记录的外部文件能够在不授予 inline 执行的情况下保留同一份源码。

**在 Vite 入口构造桌面专用模块系统或 facade。** Facade 的用途是在模块执行前捕获 classic-script registration；在 parser 阶段之后重新实现它，既会复制模块 identity 规则，也无法保留该顺序。

**只修补缺失的 facade。** 如果让 `external`、图顺序、字段转发或异步释放继续停留在旧版适配器语义，桌面 shell 对同一套上游启动协议的适配仍不完整。

## Consequences

打包 renderer 启动现在有四个显式阶段：facade、modules registration、runtime registration，最后是 Vite shell。只要最终 HTML 不再保留这些阶段，或 facade 未进入完整性清单，构建就会在打包前失败。客户端级回归会执行生产 facade、排空 parser registration，并要求真实桌面 mount 到达 live renderer，而不是失败页面。最终 package 验证仍必须启动 Electron 并检查可见 renderer，因为 `AppWebEntry` 会刻意渲染启动失败，不会让其 `run()` promise 拒绝。
