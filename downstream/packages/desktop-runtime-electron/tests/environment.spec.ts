import { describe, expect, it } from 'vitest'
import { createDesktopUtilityEnvironment } from '../src/environment.ts'

const desktopValues = {
  home: '/Users/example/Library/Application Support/DSH-GUI/harness',
  workspace: '/Users/example/Documents',
  channel: 'stable',
  presetRoot: '/Applications/DSH-GUI.app/Contents/Resources/config/agent-presets',
  secretPersistence: 'os-protected',
} as const

describe('desktop utility environment', () => {
  it('inherits only operating-system runtime fields before adding trusted desktop values', () => {
    const environment = createDesktopUtilityEnvironment({
      inherited: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/example',
        LANG: 'en_US.UTF-8',
        TMPDIR: '/private/tmp/example/',
        DEEPSEEK_API_KEY: 'deepseek-secret',
        ACOSMI_TOKEN: 'acosmi-secret',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        GITHUB_TOKEN: 'github-secret',
        NPM_TOKEN: 'npm-secret',
        SSH_AUTH_SOCK: '/private/tmp/agent.sock',
        HTTPS_PROXY: 'https://user:password@proxy.example',
        SHELL: '/tmp/injected-shell',
        NODE_OPTIONS: '--require=/tmp/injected.cjs',
        DSH_HOME: '/tmp/untrusted-home',
        DSH_TELEMETRY_DISABLED: '0',
      },
      platform: 'darwin',
      ...desktopValues,
    })

    expect(environment).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/example',
      TMPDIR: '/private/tmp/example/',
      LANG: 'en_US.UTF-8',
      DSH_HOME: desktopValues.home,
      DSH_DESKTOP_WORKSPACE: desktopValues.workspace,
      DSH_DESKTOP_CHANNEL: desktopValues.channel,
      DSH_DESKTOP_PRESET_ROOT: desktopValues.presetRoot,
      DSH_DESKTOP_SECRET_PERSISTENCE: desktopValues.secretPersistence,
      DSH_TELEMETRY_DISABLED: '1',
    })
    expect(JSON.stringify(environment)).not.toMatch(/secret|password|agent\.sock|injected/u)
  })

  it('reads Windows runtime fields without inheriting case-insensitive credential names', () => {
    const environment = createDesktopUtilityEnvironment({
      inherited: {
        Path: String.raw`C:\Windows\System32`,
        SystemRoot: String.raw`C:\Windows`,
        UserProfile: String.raw`C:\Users\Example`,
        TEMP: String.raw`C:\Users\Example\AppData\Local\Temp`,
        github_token: 'github-secret',
        deepseek_api_key: 'deepseek-secret',
        node_options: '--require=C:\\injected.cjs',
        dsh_home: String.raw`C:\untrusted`,
      },
      platform: 'win32',
      home: String.raw`C:\Users\Example\AppData\Roaming\DSH-GUI\harness`,
      workspace: String.raw`C:\Users\Example\Documents`,
      channel: 'canary',
      presetRoot: String.raw`C:\Program Files\DSH-GUI\resources\config\agent-presets`,
      secretPersistence: 'session-memory',
    })

    expect(environment).toMatchObject({
      PATH: String.raw`C:\Windows\System32`,
      SYSTEMROOT: String.raw`C:\Windows`,
      USERPROFILE: String.raw`C:\Users\Example`,
      DSH_DESKTOP_CHANNEL: 'canary',
      DSH_DESKTOP_SECRET_PERSISTENCE: 'session-memory',
      DSH_TELEMETRY_DISABLED: '1',
    })
    expect(Object.keys(environment).map(name => name.toUpperCase())).not.toEqual(expect.arrayContaining([
      'GITHUB_TOKEN',
      'DEEPSEEK_API_KEY',
      'NODE_OPTIONS',
    ]))
  })
})
