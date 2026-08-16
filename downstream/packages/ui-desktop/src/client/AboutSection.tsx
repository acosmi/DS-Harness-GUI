/** DSH-GUI About and update settings page. */

import { useEffect, useState, type ReactNode } from 'react'
import type { DesktopProductInfo, DesktopUpdateStatus } from '@acosmi/dsh-desktop-carrier-electron/protocol'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopUiKey } from './locales.ts'
import css from './AboutSection.module.css'

/** Locale dependency owned by the registration. */
export interface AboutSectionInjected {
  readonly t: (key: DesktopUiKey) => string
}

/** Settings owner share and desktop dependencies. */
export type AboutSectionProps = PropsRuntime<'settings.section'> & InjectFace<AboutSectionInjected>

/** Render immutable build facts and the explicit update action. */
export function AboutSection({ t }: AboutSectionProps): ReactNode {
  const [info, setInfo] = useState<DesktopProductInfo | null>(null)
  const [error, setError] = useState(false)
  const [update, setUpdate] = useState<DesktopUpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let active = true
    void window.dshDesktop.productInfo().then(
      result => {
        if (!active) return
        if (result.ok) setInfo(result.value)
        else setError(true)
      },
      () => { if (active) setError(true) },
    )
    return () => { active = false }
  }, [])

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      setUpdate(await window.dshDesktop.checkForUpdates())
    } catch (_updateTransportFailure) {
      setUpdate({
        status: 'error',
        message: 'The update check could not be completed.',
        checkedAt: Date.now(),
      })
    } finally {
      setChecking(false)
    }
  }

  if (error) return <p role="alert">{t('loadFailed')}</p>
  if (info === null) return <p>{t('loading')}</p>

  const rows: Array<[DesktopUiKey, string]> = [
    ['productVersion', info.version],
    ['channel', info.channel],
    ['productCommit', compact(info.productCommit)],
    ['upstream', compact(info.upstreamCommit)],
    ['sdk', info.sdkVersion],
    ['electron', info.electronVersion],
    ['signing', info.signing],
    ['secretStorage', info.secretStorage],
  ]

  return (
    <section className={css.page} aria-labelledby="desktop-about-title">
      <div>
        <h2 id="desktop-about-title">{t('title')}</h2>
        <p className={css.disclaimer}>{info.disclaimer}</p>
      </div>
      <dl className={css.facts}>
        {rows.map(([label, value]) => (
          <div className={css.row} key={label}><dt>{t(label)}</dt><dd>{value}</dd></div>
        ))}
      </dl>
      <div className={css.update}>
        <h3>{t('update')}</h3>
        <Button
          variant="outline"
          disabled={checking || info.updateMode === 'disabled'}
          onClick={() => { void check() }}
        >
          {checking ? t('checking') : t('check')}
        </Button>
        <p role={update?.status === 'error' ? 'alert' : undefined}>{updateCopy(update, t)}</p>
      </div>
    </section>
  )
}

function compact(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value
}

function updateCopy(status: DesktopUpdateStatus | null, t: (key: DesktopUiKey) => string): string {
  if (status === null) return ''
  if (status.status === 'available') return t('update.available').replace('{version}', status.version)
  return t(`update.${status.status}`)
}
