# @acosmi/dsh-desktop-update

[English](README.md) | 中文

在平台 updater 接收产物前验证独立签名的规范发行索引。封闭索引要求 UUID release id、产物最低操作系统版本、唯一的平台与架构组合、无凭据的 HTTPS 地址、规范 Ed25519 签名、尚未过期的发布时间区间以及正确的 SemVer 优先级。未知字段、重复目标、URL fragment、非 Ed25519 密钥、不兼容的操作系统和未递增版本都按失败关闭处理。索引获取会逐块读取响应，即使缺少 `Content-Length` 也会在超过一 MiB 时取消。开发构建在没有 feed 与可信公钥时保持更新关闭。
