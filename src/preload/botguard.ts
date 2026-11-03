// Runs YouTube's BotGuard in a hidden page (see main/botguard.ts), which needs a real browser to
// pass its checks. Main fetches the challenge and the integrity token; this page runs the VM and
// keeps the minter it hands back.
import { contextBridge } from 'electron'
import { BotGuardClient } from 'bgutils-js/botguard'
import { WebPoMinter } from 'bgutils-js/webpo'
import type { WebPoSignalOutput } from 'bgutils-js/shared-types'

let signals: WebPoSignalOutput = []
let minter: WebPoMinter | null = null

contextBridge.exposeInMainWorld('botguard', {
  // Loads the VM and answers the challenge; the answer goes to Google for an integrity token.
  snapshot: async (interpreter: string, program: string, globalName: string): Promise<string> => {
    new Function(interpreter)()
    const client = await BotGuardClient.create({ program, globalName, globalObject: globalThis })
    signals = []
    return client.snapshot({ webPoSignalOutput: signals })
  },
  start: async (integrityToken: string): Promise<void> => {
    minter = await WebPoMinter.create({ integrityToken }, signals)
  },
  // A PO token bound to one video, as YouTube's web player mints for each video it streams.
  mint: (videoId: string): Promise<string> => {
    if (!minter) throw new Error('BotGuard isn’t ready')
    return minter.mintAsWebsafeString(videoId)
  }
})
