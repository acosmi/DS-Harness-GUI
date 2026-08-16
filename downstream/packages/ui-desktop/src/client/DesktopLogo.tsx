/** Product-owned DSH-GUI logo shared by every renderer brand surface. */

import { DSH_GUI_LOGO_ASSET_PATH } from './branding.ts'

/** Props for the decorative product logo. */
export interface DesktopLogoProps {
  /** Square layout cell in CSS pixels; transparent source padding preserves its aspect ratio. */
  readonly size: number
  /** Optional layout class owned by the containing product surface. */
  readonly className?: string | undefined
}

/**
 * Render the product-owned whale/browser mark from the renderer integrity manifest.
 * @param props - logo size and optional layout class.
 * @returns a decorative image whose source is shared with the application icon.
 */
export function DesktopLogo({ size, className }: DesktopLogoProps) {
  return (
    <img
      src={`./${DSH_GUI_LOGO_ASSET_PATH}`}
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-dsh-gui-logo="whale-browser-v6"
    />
  )
}
