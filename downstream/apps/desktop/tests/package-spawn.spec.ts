import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { packageChildOptions } = require('../scripts/package.cjs') as {
  packageChildOptions(
    command: string,
    options?: { capture?: boolean },
    platform?: NodeJS.Platform,
    execPath?: string,
  ): {
    cwd: string
    env: NodeJS.ProcessEnv
    shell?: boolean
    stdio: 'inherit' | Array<'ignore' | 'pipe' | 'inherit'>
    windowsHide?: boolean
  }
}

const WINDOWS_NODE = 'C:\\Program Files\\nodejs\\node.exe'

describe('desktop packaging subprocess spawn', () => {
  it('runs pnpm.cmd through the Windows shell so Node 24 does not throw spawn EINVAL', () => {
    const options = packageChildOptions('pnpm.cmd', { capture: true }, 'win32', WINDOWS_NODE)
    expect(options.shell).toBe(true)
    expect(options.windowsHide).toBe(true)
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(options.env.CI).toBe('true')
  })

  it('leaves electron-builder on the Node executable without a Windows shell', () => {
    const options = packageChildOptions(WINDOWS_NODE, {}, 'win32', WINDOWS_NODE)
    expect(options.shell).toBe(false)
    expect(options.stdio).toBe('inherit')
  })

  it('does not enable a shell on POSIX packaging hosts', () => {
    const options = packageChildOptions('pnpm', { capture: true }, 'darwin', '/usr/bin/node')
    expect(options.shell).toBeUndefined()
    expect(options.windowsHide).toBeUndefined()
    expect(options.stdio).toEqual(['inherit', 'pipe', 'pipe'])
  })
})
