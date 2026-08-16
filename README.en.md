# DS Harness GUI

<p align="center"><img src="assets/branding/dsh-gui-whale-browser-logo-v6.png" alt="DS Harness GUI logo" width="128" height="128"></p>

[中文](README.md) | English

DS Harness GUI is an Acosmi community desktop distribution built from the open-source [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for macOS and Windows. It retains the Harness plugin architecture, session log, tools, and permission model while adding an Electron desktop runtime, Acosmi account and model access, release ledgers, platform packaging, and product branding.

This is not an official DeepSeek product and does not imply support or endorsement by DeepSeek. `DS Harness GUI`, the whale-browser logo, and the `@acosmi/*` packages belong to Acosmi's downstream distribution layer. The `@deepseek-ai/*` source and the DeepSeek Harness name identify the upstream project only.

## Current status

This repository is a developer preview and is not ready for a stable public release.

- Source builds, type checking, lint, desktop-focused unit tests, the keyless assembled snapshot, renderer resource integrity, and the development-package path have been validated on macOS arm64.
- The Acosmi SDK is pinned to `2.17.0`, which includes the released native OAuth `state` validation. The Nexus `web_search` name-collision fault has also been fixed and deployed server-side.
- Final authenticated validation of Kimi K3 and Acosmi DeepSeek continuation turns, parallel tool calls, and cross-model switching still requires a signed-in Canary. Passing code checks does not mean real-service acceptance is complete.
- The current macOS development package is ad hoc local evidence only. A Developer ID identity is recorded and selected explicitly, but notarization credentials, final arm64/x64 signing and stapling, Windows x64 packaging and signing, update channels, and legal and support inputs remain blocked in the release ledgers.
- `pnpm run desktop:verify` reports the current release blockers. Development builds remain available; stable signing and publishing fail closed.

<a id="run"></a>

## Run from source

Node.js `^22.19.0 || >=24` and pnpm are required.

```sh
git clone https://github.com/acosmi/DS-HarnesshGUI.git
cd DS-HarnesshGUI
pnpm install
```

### Desktop application

```sh
pnpm run desktop:dev
```

`desktop:dev` builds the workspace and desktop application, then starts Electron. Acosmi models require completing browser authorization through Settings → Acosmi Account → Sign in. The official DeepSeek provider reads configuration through the repository's existing credential rules.

<a id="run-from-source"></a>

### Web UI and general Harness use

```sh
pnpm run build
pnpm dsh web
```

`pnpm dsh web` starts the Web UI at `http://127.0.0.1:3080` by default. See the [Web UI guide](docs/user/guide/index.md) for general Harness usage.

Common commands:

```sh
pnpm run build             # Build libraries, the Web UI, and the desktop app
pnpm run test:desktop      # Run downstream desktop tests
pnpm run typecheck         # Host-before-Client type checking
pnpm run lint              # Run repository lint
pnpm run desktop:verify    # Validate release ledgers and report blockers
pnpm run desktop:package   # Build an untrusted development installer for this host
pnpm run clean             # Remove reproducible build outputs
```

## Repository layout

| Path | Purpose |
|---|---|
| `downstream/apps/desktop/` | Electron main, preload, utility process, renderer, and platform packaging entry points |
| `downstream/packages/` | Acosmi account, model provider, desktop runtime, branded UI, and update capabilities |
| `downstream/bundles/desktop/` | Fixed production plugin composition |
| `downstream/release/` | Identity, external-input, responsibility, native-module, support-matrix, and upstream-baseline ledgers |
| `packages/`, `vendor/` | The DeepSeek Harness and vendored Cordis upstream source layers |
| `assets/branding/` | DS Harness GUI product-brand source files |

See the [architecture documentation](docs/architecture.md) for the general Harness design, the [desktop application README](downstream/apps/desktop/README.md) for desktop runtime and security rules, and the [release ledger README](downstream/release/README.md) for blocker semantics.

## Security and release boundaries

- Never commit `.env` files, API keys, OAuth tokens, Apple or Windows passwords, private keys, P12 files, notarization credentials, or server login keys.
- The repository records only public certificate metadata and secret-free validation rules. Local keychain identities are not exported or uploaded.
- Production loads only the fixed desktop composition and packaged `app://` resources; it enables neither remote code nor persistent development listeners.
- Internal implementation plans, handoff drafts, and operational credentials are not part of the public source distribution. Repository documentation states current behavior, usage rules, and verifiable limitations.

## Upstream synchronization and contributions

`upstream` should point to `https://github.com/deepseek-ai/deepseek-harness.git`, while the product repository is `origin`. General capabilities belong on the upstream `packages/**` extension points when possible. Acosmi product policy, accounts, Electron code, branding, packaging, and release logic stay under `downstream/**`. Before editing, read [AGENTS.md](AGENTS.md), the [development guide](docs/development.md), and the instructions for the affected subtree.

## License

The source is available under the [MIT License](LICENSE). Direct third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The MIT license grants no trademark rights in DeepSeek or any other party's marks.
