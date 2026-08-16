/** Client assembly for the generated Acosmi account Remote namespace. */

import type { Context } from '@deepseek-ai/cordis'
import accountRemote from '@acosmi/dsh-account-acosmi/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'

export type { AcosmiAccountActionResult, AcosmiAccountSnapshot } from '@acosmi/dsh-account-acosmi/types'
export type {} from '@acosmi/dsh-account-acosmi/remote'

export const inject = ['remote']

/** Mount the account contribution into the product Remote service. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return ctx.remote.$mount(accountRemote)
}
