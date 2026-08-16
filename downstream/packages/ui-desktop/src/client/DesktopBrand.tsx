/** DSH-GUI sidebar brand visuals. */

import type { SidebarBrandOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { DesktopLogo } from './DesktopLogo.tsx'
import css from './DesktopBrand.module.css'

/** Props supplied by the generic sidebar brand seat. */
export type DesktopBrandProps = SidebarBrandOwnerProps

/**
 * Render the product display name or the collapsed product mark.
 * @param props - sidebar brand presentation variant.
 * @returns decorative wordmark content for the sidebar's New Session button.
 */
export function DesktopBrand({ variant }: DesktopBrandProps) {
  if (variant === 'mark') return <DesktopLogo className={css.logo} size={24} />
  return (
    <span
      className={css.root}
      aria-hidden="true"
      data-product-brand="DS Harness GUI"
    >
      <DesktopLogo className={css.logo} size={24} />
      <span className={css.name}>DS</span>
      <span className={css.badge}>Harness</span>
      <span className={css.name}>GUI</span>
    </span>
  )
}

/**
 * Render the same product mark above the blank-session composer.
 * @returns the decorative 34px product mark.
 */
export function DesktopHeroBrand() {
  return <DesktopLogo className={css.heroLogo} size={34} />
}
