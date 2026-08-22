# DSH-GUI downstream rules

`downstream/` contains the private Acosmi desktop distribution layered over the upstream DeepSeek Harness source tree.

- Package names use `@acosmi/dsh-*`, stay `private: true`, and are never published as official `@deepseek-ai` packages.
- Product policy, Acosmi endpoints, account behavior, Electron code, identity, packaging, and release workflows stay here.
- Imports use public package exports. Never import `packages/**/src`, copy Harness controllers, or patch generated artifacts by hand.
- Production loads only the fixed desktop composition and packaged `app://` assets. It starts no persistent HTTP or WebSocket listener and performs no remote code loading.
- Pull-request GitHub Actions that spend Actions minutes do not start automatically. Maintainers dispatch CI through the GitHub API or Actions UI ([manual DSH-GUI GitHub Actions](../.agents/notes/implemented/process/2026-08-21-dsh-gui-manual-github-actions.md)).
- macOS arm64 and x64 installers are packaged locally and uploaded with `pnpm run desktop:publish:mac`. Windows NSIS installers are packaged by dispatching [desktop-windows-package.yml](../.github/workflows/desktop-windows-package.yml). Both land on the identity ledger GitHub Release ([GitHub Release installers](../.agents/notes/implemented/process/2026-08-22-dsh-gui-github-release-installers.md)).
- Stable and canary identities, data roots, secret namespaces, update feeds, and signing allowlists remain separate.
- A public release requires signed platform artifacts, a passing release manifest/SBOM audit, and the manual code-level audit recorded for the exact RC commit.
