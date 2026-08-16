# DSH-GUI 桌面应用

[English](README.md) | 中文

面向 macOS 与 Windows 的薄 Electron 组装层。它打包不可变 renderer 图，并在 Electron utility process 中启动真实 Harness Host。每次应用构建先删除旧的 `dist/` 目录，再校验六份发行账本，然后生成新的 main、preload、utility 与 renderer 产物。

主进程从按平台封闭的命令搜索、用户目录、临时目录、区域设置与操作系统运行字段清单构造 utility process 环境，再加入渠道自有的 DSH 值。宿主的环境凭据、代理设置、可执行注入选项与 capability socket 默认不进入该环境，不再依赖一份已知 secret 名称的删除清单。凭据提供方只能通过受限的主进程桥读取继承的 `DEEPSEEK_API_KEY`，并把该来源视为只读，因此官方提供方可以使用这把 key，但 Harness shell 子进程不会从环境继承它。用户保存的凭据与 Acosmi OAuth token 继续通过按渠道绑定的 vault bridge 读写。vault 会在缓冲前拒绝过大的 profile 或密文文件，并在持久模式与开发内存模式中统一限制单值大小、条目数量和明文总量。OS 加密不可用时，持久 vault 还会拒绝读取和写入，包括密文文件尚不存在的情况，因此该状态不会被误报为“账户未配置”。utility 侧 TokenStore 会把主进程桥刻意隐藏细节的失败转换为专用本地错误，不会根据提供方可控文本猜测故障类别。

正常 shutdown 会先销毁 renderer 窗口，从而关闭由该窗口持有的原生目录对话框，再要求 utility process 卸载 Harness 树；期间特权桥继续供必需的 vault 清理使用，随后在同一 shutdown deadline 内等待主进程全部 secret、目录与浏览器操作结算。超时仍会使优雅关闭失败并终止 utility process，不会被报告为已经达到静止状态。

打包不会把正在使用的 monorepo 工作区直接交给 electron-builder。每个目标通过 pnpm 的 shared-lockfile deploy 实现进入受控的系统临时目录，再物化 pnpm 与 workspace 链接，并在不修改硬链接源码 manifest 的前提下替换仅供部署使用的依赖说明。结构化部署输出必须只把已审阅的 `dsh-subprocess-local` postinstall 标为 ignored，随后由打包器删除全部非目标 node-pty 预编译目录，并自行准备和验证目标 helper。仓库 pnpm workspace-state 文件的内容、权限与时间戳会被恢复，隔离部署同时保留 workspace `node_modules`，不会迫使后续命令重新安装依赖。Electron 熔丝设置与应用签名前，静态 workspace peer 检查、暂存文件系统递归依赖检查与 utility 导入 smoke，以及最终 ASAR 的依赖、应用文件和目标原生二进制审计必须全部通过；ASAR 审计还会独立拒绝任何漏网的非目标 node-pty 预编译件。

产品自有透明 PNG `assets/branding/dsh-gui-whale-browser-logo-v6.png` 是 macOS、Windows 应用图标与所有 renderer 产品标记的唯一源文件。electron-builder 把它转换成各平台图标格式，renderer 则把它作为 `branding/dsh-gui-whale-browser-logo-v6.png` 与代码和 HTML 一起写入同一份完整性清单。每个隔离打包目标选择单一架构，共享平台配置只声明产物格式。macOS post-pack 审计要求固定 Electron 版本实际携带的四个 helper；可选 EH helper 存在时校验其预留身份，任何未识别 helper 在发行身份账本明确登记前都会使打包失败。

stable macOS 打包通过精确 SHA-1 `A6616C59EA24F8DE1D97ECC8081AE64E3D7D6F61` 选择账本记录的 Developer ID Application 身份，避免与钥匙串中的其他有效身份产生歧义。签名后 hook 先对应用执行 deep strict 校验，核对最外层应用的当前渠道 Bundle ID 与 hardened runtime，再找出每个打包后的 Mach-O 文件，要求它们分别符合公开发行账本中的 Team ID `Z6BDN8ZHTY`、完整 Authority 链与安全时间戳。本机钥匙串身份只足以供该 Mac 构建；CI 或其他 Mac 仍需单独准备受密码保护的 P12。仓库不记录证书路径、CSR 路径、私钥、钥匙串条目、密码或公证凭据。

本地开发包不带受信发行方签名，可以在账本记录的外部输入仍受阻时构建。macOS 只做 ad hoc 签名，以便最终应用包通过结构性代码签名校验；Windows 开发产物保持未签名。从存在修改或未跟踪源码的工作树构建时，“产品版本标识”显示为 `dirty:<commit>`。记录并在本机验证 Developer ID 身份并不表示 Apple 组合发行输入已经 ready：仍需配置公证凭据，并验证最终 arm64 与 x64 产物已经完成 Developer ID 签名、公证和 staple。标记为 stable 签名的构建按失败关闭处理：只有所有已记录的生产 OAuth、SDK、签名、公证、发行索引、法律与支持输入均就绪，而且源码工作树干净后才可继续。
