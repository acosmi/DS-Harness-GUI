/** Thin sandboxed renderer entry. */

import { mountDesktopRenderer } from '@acosmi/dsh-desktop-renderer-bootstrap/client'

const root = document.getElementById('root')
if (root === null) throw new Error('DSH-GUI renderer is missing #root')

void mountDesktopRenderer(root, __DSH_DESKTOP_BOOT__)
