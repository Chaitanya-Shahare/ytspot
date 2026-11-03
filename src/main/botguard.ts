// PO tokens ("proof of origin") for downloading songs. Without one, YouTube's media servers stop
// sending a song after its first megabyte. YouTube's web player mints one per video with BotGuard,
// Google's anti-abuse VM, which has to run in a real browser: here, a hidden page (preload/botguard.ts).
// The approach and the BotGuard client come from LuanRT's bgutils-js (made for youtubei.js).
import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getChallenge } from 'bgutils-js/botguard'
import { buildURL, getHeaders } from 'bgutils-js/utils'

const dir = fileURLToPath(new URL('.', import.meta.url))
// The request key YouTube's own web player uses.
const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo'
// The page is only kept while downloads use it.
const IDLE_MS = 5 * 60 * 1000

let minter: Promise<{ page: BrowserWindow; expires: number }> | null = null
let idle: ReturnType<typeof setTimeout> | undefined

async function start(): Promise<{ page: BrowserWindow; expires: number }> {
  const challenge = await getChallenge({ requestKey: REQUEST_KEY, fetchFunction: fetch })
  const interpreter = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue
  if (!interpreter || !challenge.program || !challenge.globalName) throw new Error('BotGuard sent no challenge')
  const page = new BrowserWindow({
    show: false,
    webPreferences: { preload: join(dir, '../preload/botguard.mjs'), sandbox: false, partition: 'botguard', spellcheck: false, backgroundThrottling: false }
  })
  try {
    await page.loadURL('about:blank')
    const run = <T>(fn: string, ...args: unknown[]) =>
      page.webContents.executeJavaScript(`window.botguard.${fn}(...${JSON.stringify(args)})`) as Promise<T>
    const answer = await run<string>('snapshot', interpreter, challenge.program, challenge.globalName)
    const res = await fetch(buildURL('GenerateIT'), { method: 'POST', headers: getHeaders(), body: JSON.stringify([REQUEST_KEY, answer]) })
    if (!res.ok) throw new Error(`BotGuard refused (${res.status})`)
    const [token, ttl] = (await res.json()) as [string, number]
    await run('start', token)
    // Tokens last `ttl` seconds (12 hours); start over a little before that.
    return { page, expires: Date.now() + Math.max(60, (ttl ?? 3600) - 300) * 1000 }
  } catch (e) {
    page.destroy()
    throw e
  }
}

// Two downloads run at once, so they share one minter: whichever finds it stale starts the next,
// and a token another download's reset took away mid-mint is minted again on the fresh one.
export async function poToken(videoId: string): Promise<string> {
  clearTimeout(idle)
  try {
    for (let attempt = 0; ; attempt++) {
      const current = (minter ??= start().catch((e) => ((minter = null), Promise.reject(e))))
      const m = await current
      if (!m.page.isDestroyed() && Date.now() <= m.expires) {
        try {
          return await m.page.webContents.executeJavaScript(`window.botguard.mint(${JSON.stringify(videoId)})`)
        } catch (e) {
          if (attempt || !m.page.isDestroyed()) throw e
        }
      } else if (attempt) throw new Error('BotGuard isn’t ready')
      if (minter === current) resetBotguard()
    }
  } finally {
    clearTimeout(idle)
    idle = setTimeout(resetBotguard, IDLE_MS)
  }
}

// Drop the minter (idle, expired, or one YouTube stopped accepting); the next token starts afresh.
export function resetBotguard(): void {
  clearTimeout(idle)
  const old = minter
  minter = null
  old?.then((m) => m.page.isDestroyed() || m.page.destroy(), () => undefined)
}
