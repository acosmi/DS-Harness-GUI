/** Platform-neutral carrier registration shared by bootstrap and client plugin bundles. */

import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { ClientConnectionRpc } from './rpc.ts'

export type { ClientConnectionRpc } from './rpc.ts'

const CARRIER_SLOT = Symbol.for('@deepseek-ai/dsh-client-connection/carrier')

interface ConnectionCarrierGlobal {
  [CARRIER_SLOT]?: ConnectionCarrier
}

/** Platform transport supplied before the connection client plugin mounts. */
export interface ConnectionCarrier {
  /** API proxy implementation for unary calls and the two event streams. */
  readonly api: IApiClient
  /** Generic logical RPC channels carried alongside API proxy traffic. */
  readonly rpc: ClientConnectionRpc
  /** Whether the carrier terminates inside the same trusted host. */
  readonly isLoopback: boolean
}

/**
 * Install one platform carrier for the current JavaScript realm.
 *
 * The global symbol keeps the registration shared when a bootstrap and a
 * separately bundled client plugin contain different module instances.
 *
 * @param carrier - platform API and RPC transport.
 * @returns disposer that retracts this exact registration.
 */
export function installConnectionCarrier(carrier: ConnectionCarrier): () => void {
  const target = globalThis as ConnectionCarrierGlobal
  if (target[CARRIER_SLOT] !== undefined) {
    throw new Error('connection: a platform carrier is already installed')
  }
  target[CARRIER_SLOT] = carrier
  return () => {
    if (target[CARRIER_SLOT] === carrier) Reflect.deleteProperty(target, CARRIER_SLOT)
  }
}

/**
 * Resolve the carrier installed for this realm, if any.
 * @returns current carrier, or `undefined` before installation and after disposal.
 */
export function installedConnectionCarrier(): ConnectionCarrier | undefined {
  return (globalThis as ConnectionCarrierGlobal)[CARRIER_SLOT]
}
