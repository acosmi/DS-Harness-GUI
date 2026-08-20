/** First-run Acosmi-or-official-provider choice. */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Button, OnboardingSurface } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcosmiAccountKey } from './locales.ts'
import type { AcosmiAccountStore } from './store.ts'
import css from './AccountOnboarding.module.css'

/** Registration-owned onboarding dependencies. */
export interface AccountOnboardingInjected {
  readonly controller: AcosmiAccountStore
  readonly hooks: {
    /** Account projection bound by the UI renderer as useSnapshot. */
    readonly snapshot: AcosmiAccountStore['store']
  }
  readonly t: (key: AcosmiAccountKey) => string
}

/** Onboarding owner share plus account dependencies. */
export type AccountOnboardingProps = PropsRuntime<'settings.onboarding'> & InjectFace<AccountOnboardingInjected>

/** Render the account choice until an authorized account or alternate route completes it. */
export function AccountOnboarding({ complete, controller, useSnapshot, t }: AccountOnboardingProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)
  const account = state.account

  useEffect(() => {
    if (state.phase === 'idle') void controller.load()
  }, [controller, state.phase])

  useEffect(() => {
    if (account?.status === 'ready' || account?.status === 'degraded') complete()
  }, [account?.status, complete])

  if (state.phase === 'idle' || state.phase === 'loading'
    || account?.status === 'ready' || account?.status === 'degraded') return null

  const loginAvailable = account?.loginAvailable === true
  return (
    <OnboardingSurface>
      <section className={css.panel} aria-labelledby="acosmi-onboarding-title">
        <p className={css.eyebrow}>{t('onboardingEyebrow')}</p>
        <h1 className={css.title} id="acosmi-onboarding-title">{t('onboardingTitle')}</h1>
        <p className={css.description}>{t('onboardingDescription')}</p>
        {!loginAvailable && <p className={css.notice}>{t('loginUnavailable')}</p>}
        {state.error === null ? null : <div className={css.error} role="alert">{state.error}</div>}
        <div className={css.options}>
          <Button
            variant="primary"
            disabled={!loginAvailable || state.busy !== null}
            onClick={() => { void controller.act('login') }}
          >
            {state.busy === 'login' ? t('loggingIn') : t('onboardingAcosmi')}
          </Button>
          <Button variant="outline" disabled={state.busy !== null} onClick={complete}>
            {t('onboardingDeepSeek')}
          </Button>
          {state.phase === 'error' && <Button onClick={() => { void controller.load() }}>{t('retry')}</Button>}
        </div>
        <p className={css.disclaimer}>{t('disclaimer')}</p>
      </section>
    </OnboardingSurface>
  )
}
