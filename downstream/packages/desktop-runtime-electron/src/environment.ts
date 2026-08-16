/** Environment isolation for the desktop Harness Host utility process. */

import type { DesktopSecretPersistence } from '@acosmi/dsh-desktop-secrets/vault'
import type { DesktopChannel } from './index.ts'

const POSIX_ENVIRONMENT_NAMES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'TERM',
  'COLORTERM',
  'TZ',
  '__CF_USER_TEXT_ENCODING',
] as const

const WINDOWS_ENVIRONMENT_NAMES = [
  'PATH',
  'HOME',
  'TEMP',
  'TMP',
  'TZ',
  'LANG',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'OS',
] as const

interface DesktopUtilityEnvironmentOptions {
  readonly inherited: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly workspace: string
  readonly channel: DesktopChannel
  readonly presetRoot: string
  readonly secretPersistence: DesktopSecretPersistence
}

/**
 * Build a utility-process environment from OS runtime fields and trusted desktop values.
 * @param options Inherited process state and channel-owned desktop paths.
 * @returns A new environment that excludes ambient credentials and capability variables.
 */
export function createDesktopUtilityEnvironment(options: DesktopUtilityEnvironmentOptions): NodeJS.ProcessEnv {
  const names = options.platform === 'win32' ? WINDOWS_ENVIRONMENT_NAMES : POSIX_ENVIRONMENT_NAMES
  const env: NodeJS.ProcessEnv = {}
  for (const name of names) {
    const value = inheritedValue(options.inherited, name, options.platform === 'win32')
    if (value !== undefined) env[name] = value
  }
  env.DSH_HOME = options.home
  env.DSH_DESKTOP_WORKSPACE = options.workspace
  env.DSH_DESKTOP_CHANNEL = options.channel
  env.DSH_DESKTOP_PRESET_ROOT = options.presetRoot
  env.DSH_DESKTOP_SECRET_PERSISTENCE = options.secretPersistence
  env.DSH_TELEMETRY_DISABLED = '1'
  return env
}

function inheritedValue(
  inherited: NodeJS.ProcessEnv,
  name: string,
  caseInsensitive: boolean,
): string | undefined {
  const exact = inherited[name]
  if (exact !== undefined || !caseInsensitive) return exact
  const matched = Object.entries(inherited).find(([candidate]) => candidate.toUpperCase() === name)
  return matched?.[1]
}
