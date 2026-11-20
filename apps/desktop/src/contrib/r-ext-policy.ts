import { atom, computed } from 'nanostores'

import policyUrl from './assets/r-ext-policy-v1.wasm?url&inline'
import type { HermesPlugin } from './plugin'

type Evaluate = (request: Record<string, unknown>) => number
interface PolicyExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory
  r_ext_abi: () => number
  r_ext_input: () => number
  r_ext_evaluate: (length: number) => number
}

const activePolicy = atom<Evaluate | undefined>(undefined)
export const $rExtPolicy = computed(activePolicy, policy => policy)

export function enableBundledPolicy(): () => void {
  const [, base64] = policyUrl.split(',', 2)

  if (!base64) {
    throw new Error('r-ext-hermes requires its bundled WASM policy')
  }

  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  const wasm = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as PolicyExports

  if (wasm.r_ext_abi() !== 1) {
    throw new Error('Unsupported r-ext-hermes policy ABI')
  }

  const encode = new TextEncoder()

  const check: Evaluate = request => {
    try {
      const data = encode.encode(JSON.stringify(request))

      if (data.length > 262_144) {
        return 0
      }

      new Uint8Array(wasm.memory.buffer, wasm.r_ext_input(), data.length).set(data)

      return wasm.r_ext_evaluate(data.length)
    } catch {
      return 0
    }
  }

  activePolicy.set(check)

  return () => {
    if ($rExtPolicy.get() === check) {
      activePolicy.set(undefined)
    }
  }
}

export const bundledRExtPlugin: HermesPlugin = {
  id: 'r-ext-hermes',
  name: 'Conversation extensions',
  description: 'Reopen task notifications in chat and hide duplicate Bots room projections.',
  defaultEnabled: false,
  register(ctx) {
    ctx.onDispose(enableBundledPolicy())
  }
}
