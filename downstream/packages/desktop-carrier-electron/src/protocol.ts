/** Current renderer-to-main desktop carrier protocol. */
export const DESKTOP_PROTOCOL_VERSION = 1 as const

/** Maximum JSON request or response body accepted by the IPC carrier. Matches the upstream `/api` default so a legal 200 MiB image batch still fits after base64 expansion. */
export const MAX_DESKTOP_BODY_BYTES = 300 * 1024 * 1024

/** Maximum renderer operations awaiting a utility-process reply. */
export const MAX_DESKTOP_PENDING_CALLS = 256

/** Maximum pull-based event streams retained by one renderer connection. */
export const MAX_DESKTOP_ACTIVE_STREAMS = 8

/** Maximum privileged main-process operations awaiting a reply. */
export const MAX_DESKTOP_HOST_CALLS = 32

/** Packaged renderer URL base accepted by Electron main. */
export const DESKTOP_RENDERER_ORIGIN = 'app://dsh-gui'

/**
 * Test whether a parsed URL has the exact renderer scheme and authority.
 * Custom WHATWG schemes report a null `origin`, so callers must use the URL
 * components and then validate the operation-specific path/query separately.
 * @param url - parsed candidate URL.
 * @returns true only for the credential-free DSH-GUI renderer authority.
 */
export function isDesktopRendererUrl(url: URL): boolean {
  return url.protocol === 'app:' && url.hostname === 'dsh-gui'
    && url.username === '' && url.password === '' && url.port === ''
}

/** Unary request crossing the isolated preload bridge. */
export interface DesktopUnaryRequest {
  readonly version: typeof DESKTOP_PROTOCOL_VERSION
  readonly requestId: string
  readonly url: string
  readonly method: 'POST'
  readonly headers: readonly (readonly [string, string])[]
  readonly body: ArrayBuffer
}

/** Unary response returned to the renderer. */
export interface DesktopUnaryResponse {
  readonly version: typeof DESKTOP_PROTOCOL_VERSION
  readonly status: number
  readonly headers: readonly (readonly [string, string])[]
  readonly body: ArrayBuffer
}

/** Result of admitting and retaining a renderer-owned pull stream. */
export type DesktopStreamOpenResult =
  | { readonly ok: true; readonly streamId: string }
  | { readonly ok: false; readonly message: string }

/** One pull-based stream item returned through a dedicated MessagePort. */
export type DesktopStreamItem =
  | { readonly type: 'opened'; readonly status: number; readonly headers: readonly (readonly [string, string])[] }
  | { readonly type: 'chunk'; readonly data: ArrayBuffer }
  | { readonly type: 'end' }
  | { readonly type: 'error'; readonly message: string }

/** Non-sensitive product and build facts displayed by the About page. */
export interface DesktopProductInfo {
  readonly productName: 'DSH-GUI'
  readonly displayNameZh: 'DeepSeek Harness 桌面端'
  readonly version: string
  readonly channel: 'stable' | 'canary'
  readonly productCommit: string
  readonly upstreamCommit: string
  readonly sdkVersion: string
  readonly electronVersion: string
  readonly signing: 'development-unsigned' | 'signed'
  readonly secretStorage: 'os-protected' | 'session-memory'
  readonly updateMode: 'disabled' | 'manual'
  readonly disclaimer: string
}

/** Result of reading non-sensitive product facts from the current trusted document. */
export type DesktopProductInfoResult =
  | { readonly ok: true; readonly value: DesktopProductInfo }
  | { readonly ok: false }

/** Client-safe result of an explicit update check. */
export type DesktopUpdateStatus =
  | { readonly status: 'disabled'; readonly message: string }
  | { readonly status: 'current'; readonly checkedAt: number }
  | { readonly status: 'available'; readonly version: string; readonly checkedAt: number }
  | { readonly status: 'error'; readonly message: string; readonly checkedAt: number }

/** Minimal object exposed by preload into the sandboxed renderer. */
export interface DesktopPreloadBridge {
  readonly version: typeof DESKTOP_PROTOCOL_VERSION
  request(request: DesktopUnaryRequest): Promise<DesktopUnaryResponse>
  cancel(requestId: string): void
  openStream(url: string): Promise<DesktopStreamOpenResult>
  nextStream(streamId: string): Promise<DesktopStreamItem>
  closeStream(streamId: string): void
  productInfo(): Promise<DesktopProductInfoResult>
  checkForUpdates(): Promise<DesktopUpdateStatus>
}

declare global {
  interface Window {
    /** Frozen, versioned preload API; no Electron object crosses this boundary. */
    readonly dshDesktop: DesktopPreloadBridge
  }
}
