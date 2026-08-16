# @acosmi/dsh-desktop-renderer-bootstrap

[English](README.md) | 中文

生成不可变的生产客户端允许清单，把精确的客户端 bundle 复制到 renderer 资源，并通过 Electron carrier 启动上游 `AppWebEntry`。第 2 版资源清单记录每个 Vite 最终输出字节的完整 SHA-256；自定义协议在提供选定文件前再次验证，renderer 启动只接受无凭据的精确 `app://dsh-gui/plugins/` URL 与规范 revision query。生产环境不扫描本地插件，也不下载 JavaScript。
