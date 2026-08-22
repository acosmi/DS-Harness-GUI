# @acosmi/dsh-desktop-renderer-bootstrap

[English](README.md) | 中文

生成不可变的生产客户端允许清单，把精确的客户端 bundle 复制到 renderer 资源，并通过官方 `__DSH_TRANSPORT__` 钩子启动上游 `AppWebEntry`。该图保留每个 `dsh.client.external` 请求，并把动态提供方排在消费者之前。允许清单把 `dsh-client-ui-renderer` 作为动态客户端插件承载，并纳入 web-app 的附件与 `@` 引用插件，使 Vision 摄入与 composer 引用占用与 Host 名册相同的 slot。客户端条目只有在上游 `PLATFORM_MODULES` 基座提供某个由 shell 静态提供的包时，才能将其声明为包依赖，静态 Web shell 负责启动，并在插件图激活后移交挂载点。桌面图省略 `ui-brand-official`；产品标识来自 overlay 品牌座位。

Renderer HTML 先加载 content-addressed、同源的模块 loader facade，再把 modules 与 runtime classic bundle 作为阻塞式 parser preload 加载，最后才执行 Vite module 入口。构建会拒绝缺失或乱序的 preload 以及任何 inline script，从而保留 `script-src 'self'`。第 2 版资源清单记录每个 Vite 最终输出字节的完整 SHA-256，包括 facade；自定义协议在提供选定文件前再次验证，renderer 启动只接受无凭据的精确 `app://dsh-gui/plugins/` URL 与规范 revision query。生产环境不扫描本地插件，也不下载 JavaScript。
