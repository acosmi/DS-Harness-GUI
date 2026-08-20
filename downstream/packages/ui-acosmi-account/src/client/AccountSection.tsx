/** Acosmi account settings page. */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {} from '@acosmi/dsh-desktop-carrier-electron/protocol'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcosmiAccountKey } from './locales.ts'
import type { AcosmiAccountStore } from './store.ts'
import css from './AccountSection.module.css'

/** Registration-owned settings page dependencies. */
export interface AccountSectionInjected {
  readonly controller: AcosmiAccountStore
  readonly hooks: {
    /** Account projection bound by the UI renderer as useSnapshot. */
    readonly snapshot: AcosmiAccountStore['store']
  }
  readonly t: (key: AcosmiAccountKey) => string
}

/** Settings owner share plus account dependencies. */
export type AccountSectionProps = PropsRuntime<'settings.section'> & InjectFace<AccountSectionInjected>

/** Render client-safe account, quota, membership evidence, and actions. */
export function AccountSection({ controller, useSnapshot, t }: AccountSectionProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const busy = state.busy
  const [sessionOnly, setSessionOnly] = useState(false)

  useEffect(() => {
    void controller.resume()
  }, [controller])

  const pollAfterMs = state.account?.status === 'ready' || state.account?.status === 'degraded'
    ? state.account.pollAfterMs
    : undefined
  useEffect(() => {
    if (pollAfterMs === undefined || busy !== null) return
    const timer = window.setInterval(() => { void controller.load() }, pollAfterMs)
    return () => { window.clearInterval(timer) }
  }, [busy, controller, pollAfterMs])

  useEffect(() => {
    let active = true
    void window.dshDesktop.productInfo().then(result => {
      if (active && result.ok) setSessionOnly(result.value.secretStorage === 'session-memory')
    }, () => undefined)
    return () => { active = false }
  }, [])

  const account = state.account
  const status = account?.status ?? 'signed-out'
  const claim = account?.quotaMultiplierClaim
  const ratio = claim === undefined ? undefined : `≥${formatNumber(claim.minimum)}×`

  return (
    <section className={css.page} aria-labelledby="acosmi-account-title">
      <div className={css.heading}>
        <h2 id="acosmi-account-title">{t('title')}</h2>
        <p>{t('subtitle')}</p>
      </div>

      {sessionOnly ? <div className={css.notice} role="status">{t('sessionOnly')}</div> : null}
      {status === 'ready' ? <div className={css.notice} role="status">{t('modelRouteNotice')}</div> : null}

      <div className={css.grid}>
        <article className={css.card}>
          <h3>{t('status')}</h3>
          <div className={css.statusRow}>
            <span className={css.statusDot} data-state={status} aria-hidden="true" />
            <span>{t(`status.${status}`)}</span>
          </div>
          {account?.message === undefined ? null : <p className={css.muted}>{account.message}</p>}
        </article>

        <article className={css.card}>
          <h3>{t('membership')}</h3>
          <p>{account?.membership?.planName ?? t('membershipNone')}</p>
          {account?.membership?.expiresAt === undefined
            ? null
            : <p className={css.muted}>{t('expires')}: {formatDate(account.membership.expiresAt)}</p>}
        </article>

        {account?.quota === undefined ? null : (
          <article className={css.card}>
            <h3>{t('quota')}</h3>
            <div className={css.quotaRow}><span>{t('freeQuota')}</span><strong>{formatNumber(account.quota.freeRemainingEtu)}</strong></div>
            <div className={css.quotaRow}><span>{t('paidQuota')}</span><strong>{formatNumber(account.quota.paidRemainingEtu)}</strong></div>
            {account.quota.nextExpiry === undefined
              ? null
              : <p className={css.muted}>{t('expires')}: {formatDate(account.quota.nextExpiry)}</p>}
          </article>
        )}

        <article className={`${css.card} ${css.benefit}`}>
          <h3>{t('verifiedBenefit')}</h3>
          {ratio === undefined ? (
            <p>{t('neutralBenefit')}</p>
          ) : (
            <>
              <div className={css.ratio}>{ratio}</div>
              <p>{t('verifiedBenefitCopy').replace('{ratio}', ratio)}</p>
              <span className={css.verified}>{t('verified')}</span>
            </>
          )}
        </article>
      </div>

      {state.error === null ? null : <div className={css.error} role="alert">{state.error}</div>}
      <div className={css.actions}>
        {status === 'ready' || status === 'degraded' ? (
          <>
            <Button variant="outline" disabled={busy !== null} onClick={() => { void controller.act('refresh') }}>
              {busy === 'refresh' ? t('refreshing') : t('refresh')}
            </Button>
            <Button disabled={busy !== null} onClick={() => { void controller.act('logout') }}>
              {busy === 'logout' ? t('loggingOut') : t('logout')}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            disabled={busy !== null || account?.loginAvailable !== true}
            onClick={() => { void controller.act('login') }}
          >
            {busy === 'login' ? t('loggingIn') : t('login')}
          </Button>
        )}
        {state.phase === 'error' && <Button onClick={() => { void controller.load() }}>{t('retry')}</Button>}
      </div>
      <p className={css.disclaimer}>{t('disclaimer')}</p>
    </section>
  )
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}
