# @acosmi/dsh-desktop-renderer-bootstrap

English | [中文](README.zh.md)

Builds the immutable production client allowlist, copies exact client bundles into the packaged renderer, and starts the upstream `AppWebEntry` over the Electron carrier. The allowlist carries `dsh-client-ui-renderer` as a dynamic client plugin; a client entry may name a shell-static package dependency only when the upstream `PLATFORM_MODULES` baseline supplies it, while the static web shell owns boot and hands off its mount point after the graph activates. The version 2 asset manifest records the full SHA-256 of every final Vite output byte; the custom protocol verifies the selected file again before serving it, while renderer boot accepts only the exact credential-free `app://dsh-gui/plugins/` URL and canonical revision query. Production never scans local plugins or downloads JavaScript.
