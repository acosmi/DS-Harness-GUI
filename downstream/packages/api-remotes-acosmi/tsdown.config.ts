import { clientBundle } from '../../../packages/client/tsdown.client.ts'

export default clientBundle('@acosmi/dsh-api-remotes-acosmi', ['lib/types/index.js'], {
  hostPhase: true,
  inlineWireImports: [/^@acosmi\/dsh-account-acosmi\/remote$/],
})
