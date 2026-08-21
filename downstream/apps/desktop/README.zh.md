# DSH-GUI 桌面应用

[English](README.md) | 中文

面向 macOS 与 Windows 的薄 Electron 组装层。它打包不可变 renderer 图，并在 Electron utility process 中启动真实 Harness Host。每次应用构建先删除旧的 `dist/` 目录，再校验六份发行账本，然后生成新的 main、preload、utility 与 renderer 产物。

Renderer 会在执行桌面专有的 bundle URL 与 revision 检查后，转发原始客户端图的全部字段；完整 wire 校验仍由上游 parser 唯一负责。其文档会在 Vite module 入口前，依次把完整性清单记录的模块 loader facade、modules bundle 与 runtime bundle 作为同源 classic script 加载；在 `script-src 'self'` 策略下，只要顺序变化或出现 inline script，构建就会失败。

主进程从按平台封闭的命令搜索、用户目录、临时目录、区域设置与操作系统运行字段清单构造 utility process 环境，再加入渠道自有的 DSH 值。宿主的环境凭据、代理设置、可执行注入选项与 capability socket 默认不进入该环境，不再依赖一份已知 secret 名称的删除清单。凭据提供方只能通过受限的主进程桥读取继承的 `DEEPSEEK_API_KEY`，并把该来源视为只读，因此官方提供方可以使用这把 key，但 Harness shell 子进程不会从环境继承它。用户保存的凭据与 Acosmi OAuth token 继续通过按渠道绑定的 vault bridge 读写。签名构建要求使用 OS 保护 vault，并在加密不可用、Linux 后端不受保护或尚未确定时失败关闭；未签名开发构建会在 Electron 于 app ready 后确认存在操作系统加密时选择该 vault，否则使用进程内存，Linux `basic_text` 或尚未确定的后端绝不具备持久化资格。产品信息响应报告该次应用生命周期实际构造的 vault。vault 会在缓冲前拒绝过大的 profile 或密文文件，并在两种模式中统一限制单值大小、条目数量和明文总量。utility 侧 TokenStore 会把主进程桥刻意隐藏细节的失败转换为专用本地错误，不会根据提供方可控文本猜测故障类别。

正常 shutdown 会先销毁 renderer 窗口，从而关闭由该窗口持有的原生目录对话框，再要求 utility process 卸载 Harness 树；期间特权桥继续供必需的 vault 清理使用，随后在同一 shutdown deadline 内等待主进程全部 secret、目录与浏览器操作结算。超时仍会使优雅关闭失败并终止 utility process，不会被报告为已经达到静止状态。

打包不会把正在使用的 monorepo 工作区直接交给 electron-builder。每个目标通过 pnpm 的 shared-lockfile deploy 实现进入受控的系统临时目录，再物化 pnpm 与 workspace 链接，并在不修改硬链接源码 manifest 的前提下替换仅供部署使用的依赖说明。deploy 会显式禁用全部依赖生命周期脚本，并拒绝结构化输出中的任何生命周期事件，避免跨架构目标按宿主架构运行原生安装器；随后由打包器删除全部非目标 node-pty 预编译目录，并自行准备和验证目标 helper。仓库 pnpm workspace-state 文件的内容、权限与时间戳会被恢复，隔离部署同时保留 workspace `node_modules`，不会迫使后续命令重新安装依赖。部署前，静态闭包检查从应用 manifest 读取必需的 workspace peer，验证桌面 bundle 可从该部署根目录到达，从 bundle 的直接依赖中检查每个随附 agent preset 在受支持目标上启用的 bare plugin，并从 release support matrix 获取这些目标。该检查、暂存文件系统递归依赖检查与 utility 导入 smoke，以及最终 ASAR 的依赖、应用文件和目标原生二进制审计必须全部通过，随后才能设置 Electron 熔丝并签名应用；ASAR 审计还会独立拒绝任何漏网的非目标 node-pty 预编译件。

产品自有透明 PNG `assets/branding/dsh-gui-whale-browser-logo-v6.png` 是 macOS、Windows 应用图标与所有 renderer 产品标记的唯一源文件。electron-builder 把它转换成各平台图标格式，renderer 则把它作为 `branding/dsh-gui-whale-browser-logo-v6.png` 与代码和 HTML 一起写入同一份完整性清单。每个隔离打包目标选择单一架构，共享平台配置只声明产物格式。macOS post-pack 审计要求固定 Electron 版本实际携带的四个 helper；可选 EH helper 存在时校验其预留身份，任何未识别 helper 在发行身份账本明确登记前都会使打包失败。

candidate 与 stable macOS 打包都会通过精确 SHA-1 `A6616C59EA24F8DE1D97ECC8081AE64E3D7D6F61` 选择账本记录的 Developer ID Application 身份，避免与钥匙串中的其他有效身份产生歧义。自定义签名器会把该 SHA-1 原样传给最终 codesign 调用，不允许 electron-builder 把它替换成可能重复的证书通用名称。暂存任一架构前，打包器只删除该目标的指定 DMG、ZIP 与 blockmap，避免失败执行把同名旧分发包留在 candidate 集合中。两种模式都要求且只允许一组完整的 electron-builder 公证凭据。electron-builder 提交并 staple 应用后，签名后 hook 会先对应用执行 deep strict 校验，核对最外层应用的当前渠道 Bundle ID 与 hardened runtime，再找出每个打包后的 Mach-O 文件，要求它们分别包含账本记录的叶证书 SHA-1，并符合公开发行账本中的 Team ID `Z6BDN8ZHTY`、完整 Authority 链、安全时间戳，而且只包含隔离构建的目标架构；随后还会验证应用 ticket 与 Gatekeeper 验收。DMG 与 ZIP 生成后，打包器会在提交前验证最终 DMG 的签名和精确签名证书；Apple 接受并 staple ticket 后，再检查 ticket、UDIF 完整性、未改变的 cdhash 与 Gatekeeper 验收，从 staple 后的字节重建 electron-builder 兼容的 DMG blockmap，然后解开 ZIP 并重复完整应用检查。本机钥匙串身份只足以供该 Mac 构建；CI 或其他 Mac 仍需单独准备受密码保护的 P12。仓库不记录证书路径、CSR 路径、私钥、钥匙串条目、密码或公证凭据。

本地开发包不带受信发行方签名，可以在账本记录的外部输入仍受阻时构建。macOS 只做 ad hoc 签名，以便最终应用包通过结构性代码签名校验；Windows 开发产物保持未签名。从存在修改或未跟踪源码的工作树构建时，“产品版本标识”显示为 `dirty:<commit>`。`pnpm run desktop:package:mac:candidate` 只用于从干净 commit 生成 Developer ID 已签名、已公证、已 staple 的 arm64 与 x64 证据，以便关闭 Apple 与平台输入；该命令不会把任何输入标为 ready，也不授权发布或 stable 提升。`pnpm run desktop:package:mac:stable` 还要求所有已记录的生产 OAuth、SDK、签名、公证、发行索引、法律、平台与支持输入均已就绪，并且冻结产品 commit 与当前 checkout 一致。
