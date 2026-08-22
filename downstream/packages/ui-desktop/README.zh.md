# @acosmi/dsh-ui-desktop

[English](README.md) | 中文

桌面产品 UI 贡献。同一份产品自有鲸鱼／浏览器源资产用于展开态 `DS Harness GUI` 字标、收起态侧边栏标记、空白会话标题标记和打包应用图标。`Harness` 继续突出显示；通用 `sidebar.brand` 与 `conversation.hero.brand` seat 把 New Session、侧边栏切换、标题布局和动画行为继续留给上游外壳。包、应用与发行的规范身份仍为 `DSH-GUI`。

本包同时提供桌面专用的“关于”和更新设置界面。它展示可安全进入客户端的构建来源信息，并把更新检查委托给带版本的 preload bridge。

官方 DeepSeek API 路由在凭据状态尚未确认前保持可选。只有确认缺少或无法读取 API Key 时才拦截该分组；进行中的状态读取不会停用 composer，也不会丢掉一次点击。

renderer 会把源资产 `assets/branding/dsh-gui-whale-browser-logo-v6.png` 作为同源路径 `branding/dsh-gui-whale-browser-logo-v6.png` 发出并写入完整性清单，所有产品标记都引用这一个路径。图像仅作装饰（`alt=""`、`aria-hidden`），不能导航或注入标记。
