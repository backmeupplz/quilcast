// One of the workers native.ts mines with: it tries nonces whose high half is `hi`, `hi + step`, … until one meets
// `bits`, then posts it. The page ends it once any worker has found one.
import { search } from './pow.ts'

const me = self as unknown as { onmessage: (e: MessageEvent) => void; postMessage: (m: unknown) => void }
me.onmessage = ({ data: { custody, anchor, bits, hi, step } }: MessageEvent) => {
  for (let h = hi; h < 2 ** 32; h += step) {
    const lo = search(custody, anchor, bits, h, 0, 2 ** 32)
    if (lo >= 0) return me.postMessage({ hi: h, lo })
  }
  me.postMessage({ error: true })
}
