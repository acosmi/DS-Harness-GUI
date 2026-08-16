/** Thin sandboxed renderer entry. */

import { mountDesktopRenderer } from '@acosmi/dsh-desktop-renderer-bootstrap/client'

const root = document.getElementById('root')
if (root === null) throw new Error('DSH-GUI renderer is missing #root')

void mountDesktopRenderer(root, {
  rev: __DSH_DESKTOP_BOOT__.rev,
  entries: __DSH_DESKTOP_BOOT__.entries.map(({ id, url, rev, inject, immediately }) => ({
    id,
    url,
    rev,
    ...(inject === undefined ? {} : { inject: [...inject] }),
    ...(immediately === undefined ? {} : { immediately }),
  })),
})
