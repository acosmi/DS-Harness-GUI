# @acosmi/dsh-desktop-directory-picker

[English](README.md) | 中文

DSH-GUI 私有 Host provider，通过 Electron 主进程承载 Harness 原生目录选择能力。renderer 不能直接提交路径；Electron 只把用户选中的绝对目录返回 utility process。
