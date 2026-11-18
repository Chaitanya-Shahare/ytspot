# ytspot

A YouTube Music app for macOS with a Spotify-style UI. Electron, React, TypeScript, electron-vite.
The user listens to music with the installed copy (`/Applications/ytspot.app`) while working on
it, so testing must never touch that copy or its data (see Testing).

## How it fits together

- **The player is YouTube Music's own web page**, in a hidden window (`src/main/player.ts`).
  Main sends it commands and reads its state by running JavaScript in it (`executeJavaScript`)
  and reading YTM's DOM and its internal queue store. This is the most fragile part: when YouTube
  changes its page, play, next/prev, the queue or likes break. `npm run test:smoke` checks them.
- **The UI** (`src/renderer`) is a React page in the main window's `WebContentsView`. It talks to
  main only through `window.ytm` (`src/preload/index.ts`). Main pushes player state to it once a
  second (`pushState` in `src/main/index.ts`).
- **Data** (home, search, playlists, artists, albums) comes from youtubei.js (`src/main/api.ts`),
  signed in with the YTM page's cookies, not from the page itself.
- **Downloads** (`downloads.ts`, `botguard.ts`) play from disk through a second hidden page
  (`local.ts`). `currentState()` in index.ts returns whichever player is active.
- Other parts: lyrics from LRCLIB with YTM as fallback (`lyrics.ts`); experimental chords worked
  out from the audio (`chords.ts`, `chord-detect.ts`, off by default); menu bar item (`tray.ts`);
  self-updater from GitHub releases (`updater.ts`); Spotify import (`transfer/`, loaded on first use).
- Shared types are in `src/shared/types.ts`. Shortcuts and their defaults are in `src/shared/shortcuts.ts`.

## Logs (read these first for a bug report)

- `~/Library/Logs/ytspot/main.log`, rotated to `main.1.log` … `main.4.log` (5 MB each). Written by
  `src/main/log.ts`, which is imported first in index.ts.
- It holds all main-process `console.*` output, crashes and hangs (`[crash]`, `[hang]`), page load
  failures, UI errors (`[ui]`), playback (`[player]`, `[cmd]`), `[auth]`, `[update]` and
  `[power]` lines, and an hourly `[health]` line with memory per process type.
- **Help → Report a Problem** writes `[user] reported a problem here` and copies the last 2 hours
  to the clipboard. If a pasted log has that marker, start there.
- Native crash dumps are in `~/Library/Application Support/ytspot/Crashpad`.
- Logging new things: use `console.info/warn/error('[area] …')` in main, or `log()` from
  `log.ts`. Never log cookies, tokens or auth headers (`scrub` blanks the known ones). A message
  that repeats is written once, followed by "repeated N more times", so a hot loop can't flood the log.

## Commands

```bash
npm run dev            # hot-reload dev run (uses the real profile: avoid while the user is listening)
npm run typecheck
npm run build          # to out/
npm run test:smoke     # build, then check playback end to end in a throwaway profile (~30 s)
npm run test:chords    # chord shape tests
npm run test:transfer  # Spotify import matching tests
npm run soak           # 48 h playback run; report in ~/Library/Logs/ytspot-soak/<start>/report.md
```

Before calling a change done: `npm run typecheck`, `npm run build` and `npm run test:smoke`, plus
the unit tests for whatever area you touched.

## Testing (never touch the installed app)

- Run test copies with `YTSPOT_PROFILE=<tmp dir> YTSPOT_MUTE=1 YTSPOT_HEADLESS=1 npx electron .
  --remote-debugging-port=<free port>`. You get a separate profile, a mock keychain, no media
  keys, muted audio and no window or Dock icon. Its log goes to `<profile>/logs/`.
- Drive the app over CDP, using `window.ytm.*` in the UI page. Add `--inspect=<port>` to
  evaluate in main (`require('electron')` works there).
- Other workspaces run test copies at the same time. Pick a free port, check that the page URL
  is this checkout's `out/renderer`, and stop only your own copy (`pkill -f remote-debugging-port=<port>`).
- Signed-in checks: copy `~/Library/Application Support/ytspot/Partitions/ytm/Cookies` read-only
  into the test profile (`npm run test:smoke -- --signed-in` does this). Account changes must be
  reversible and guarded: check the target song in the same step, and like then unlike only songs
  that weren't already liked.

## Conventions

- Comments explain why, in plain sentences, for someone new to the code. Keep that style.
- Conventional commits. Don't commit or push without the user's say-so.
- Releases: squash-merge the PR, bump the version on main, build and ad-hoc sign the zip, then a
  GitHub release with `ytspot-update.json` (`scripts/update-manifest.mjs`), then the Homebrew tap.
