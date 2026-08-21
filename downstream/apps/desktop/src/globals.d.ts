declare global {
  const __DSH_DESKTOP_BOOT__: unknown
  const __DSH_BUILD_FACTS__: {
    readonly channel: 'stable' | 'canary'
    readonly productCommit: string
    readonly upstreamCommit: string
    readonly sdkVersion: string
    readonly signing: 'development-unsigned' | 'signed'
    readonly identity: {
      readonly productName: string
      readonly bundleId: string
      readonly windowsAumid: string
      readonly protocol: string
      readonly userDataDirectory: string
      readonly harnessDirectory: string
      readonly vaultFilename: string
      readonly profileFilename: string
      readonly secretNamespace: string
      readonly oauthIssuer: 'https://acosmi.com'
    }
  }
}

export {}
