// No ads without Premium. A signed-out (or non-Premium) player response lists the ads to play
// (`adPlacements`: a preroll and an end-of-song break), so those are removed before YTM's player
// reads them, the way uBlock Origin's json-prune does on youtube.com. The ad servers and ad stats
// beacons are blocked too, and any ad that still starts (one stitched into the stream, say) is
// fast-forwarded, muted, and skipped as soon as YouTube allows.
import type { WebContents } from 'electron'

// Requests the YTM session never makes: ad servers, ad breaks and ad/conversion beacons.
export const AD_URLS = [
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*',
  '*://*.googleadservices.com/*',
  '*://*/pagead/*',
  '*://*.youtube.com/api/stats/ads*',
  '*://*.youtube.com/get_midroll_info*',
  '*://*.youtube.com/youtubei/v1/player/ad_break*'
]
// The same list, for telling them apart in a listener that also sees other URLs.
export const isAdUrl = (url: string): boolean =>
  /^[a-z]+:\/\/([^/]*\.)?(doubleclick\.net|googlesyndication\.com|googleadservices\.com)\/|^[a-z]+:\/\/[^/]+\/pagead\/|^[a-z]+:\/\/([^/]*\.)?youtube\.com\/(api\/stats\/ads|get_midroll_info|youtubei\/v1\/player\/ad_break)/.test(url)

// Runs in the page before any of YTM's own scripts, on every load.
const NO_ADS_JS = `(() => {
  const KEYS = ['adPlacements', 'adSlots', 'playerAds']
  // A player response arrives on its own (/player) or inside another (playerResponse).
  const prune = (o) => {
    if (o && typeof o === 'object')
      for (const r of [o, o.playerResponse]) if (r && typeof r === 'object') for (const k of KEYS) if (k in r) delete r[k]
    return o
  }
  const parse = JSON.parse
  JSON.parse = function () { return prune(parse.apply(this, arguments)) }
  const json = Response.prototype.json
  Response.prototype.json = function () { return json.call(this).then(prune) }
  let initial
  Object.defineProperty(window, 'ytInitialPlayerResponse', { configurable: true, get: () => initial, set: (v) => { initial = prune(v) } })

  // An ad that plays anyway: 16x and muted until it's over (or skippable), then back to normal.
  // Media events don't bubble, but a capturing listener on document sees them.
  let was = null
  document.addEventListener('timeupdate', (e) => {
    const v = e.target, p = document.getElementById('movie_player')
    if (!(v instanceof HTMLVideoElement) || !p) return
    if (p.classList.contains('ad-showing')) {
      was ??= { muted: v.muted, rate: v.playbackRate }
      v.muted = true
      v.playbackRate = 16
      p.querySelector('.ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button')?.click()
    } else if (was) {
      v.muted = was.muted
      v.playbackRate = was.rate
      was = null
    }
  }, true)
})()`

// Installs the above for every page `wc` loads from now on (call before its first load). DevTools
// doesn't answer until there's a page to attach to, so a blank one comes first.
export async function blockAds(wc: WebContents): Promise<void> {
  try {
    await wc.loadURL('about:blank')
    wc.debugger.attach('1.3')
    // Without the Page domain on, the script isn't carried over to the next page.
    await wc.debugger.sendCommand('Page.enable')
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: NO_ADS_JS })
  } catch (e) {
    console.error('[adblock]', (e as Error).message)
  }
}
