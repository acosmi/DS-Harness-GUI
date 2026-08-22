# @acosmi/dsh-ui-desktop

English | [中文](README.zh.md)

Desktop product UI contributions. One product-owned whale/browser source asset fills the expanded `DS Harness GUI` wordmark, collapsed sidebar mark, blank-session hero mark, and packaged application icon. `Harness` remains emphasized; the generic `sidebar.brand` and `conversation.hero.brand` seats leave New Session, sidebar-toggle, headline geometry, and animation behavior with their upstream shells. The canonical package, application, and release identity remains `DSH-GUI`.

The package also provides the desktop-only About and update settings surface. It displays client-safe build provenance and delegates update checks to the versioned preload bridge.

The official DeepSeek API route stays selectable until its credential status is known. Only a confirmed missing or unreadable API key blocks that group; an in-flight status read does not disable the composer or discard a click.

The renderer emits the source asset `assets/branding/dsh-gui-whale-browser-logo-v6.png` at the same-origin path `branding/dsh-gui-whale-browser-logo-v6.png`, records it in the integrity manifest, and makes every product mark reference that one path. The image is decorative (`alt=""`, `aria-hidden`) and cannot navigate or inject markup.
