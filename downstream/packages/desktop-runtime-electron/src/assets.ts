/** Validation of the renderer asset integrity manifest and served bytes. */

import { createHash } from 'node:crypto'

/** Parsed renderer path-to-SHA-256 allowlist. */
export type DesktopAssetManifest = ReadonlyMap<string, string>

/**
 * Parse one strict build-generated renderer asset manifest.
 * @param raw - untrusted manifest text from the packaged application.
 * @returns immutable path-to-hash records.
 */
export function parseDesktopAssetManifest(raw: string): DesktopAssetManifest {
  const value = JSON.parse(raw) as unknown
  if (!isExactRecord(value, ['version', 'files']) || value.version !== 2 || !Array.isArray(value.files)) {
    throw new Error('desktop renderer asset manifest is invalid')
  }
  const result = new Map<string, string>()
  for (const entry of value.files) {
    if (!isExactRecord(entry, ['path', 'sha256'])
      || typeof entry.path !== 'string' || !isAssetPath(entry.path)
      || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      throw new Error('desktop renderer asset manifest contains an invalid record')
    }
    if (result.has(entry.path)) throw new Error('desktop renderer asset manifest contains a duplicate')
    result.set(entry.path, entry.sha256)
  }
  if (!result.has('index.html')) throw new Error('desktop renderer asset manifest omits index.html')
  return result
}

/**
 * Authenticate one renderer resource and its optional plugin revision query.
 * @param manifest - parsed packaged-resource allowlist.
 * @param resource - normalized relative renderer path.
 * @param search - request query string, including its leading `?`.
 * @param body - exact bytes read from the packaged resource.
 */
export function verifyDesktopAsset(
  manifest: DesktopAssetManifest,
  resource: string,
  search: string,
  body: Uint8Array,
): void {
  const expected = manifest.get(resource)
  if (expected === undefined) throw new Error('desktop renderer resource is not allowlisted')
  if (resource.startsWith('plugins/')) {
    const match = /-([0-9a-f]{16})\.js$/u.exec(resource)
    if (match === null || search !== `?rev=${match[1]}` || !expected.startsWith(match[1]!)) {
      throw new Error('desktop renderer plugin revision does not match its asset')
    }
  } else if (search !== '') {
    throw new Error('desktop renderer non-plugin resource rejects query parameters')
  }
  const actual = createHash('sha256').update(body).digest('hex')
  if (actual !== expected) throw new Error('desktop renderer resource hash does not match its manifest')
}

function isAssetPath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\')
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key))
}
