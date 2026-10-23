# ytspot

Personal Spotify-style macOS client for YouTube Music. Not for distribution.

- UI: Electron + React, styled with design tokens read from Spotify 1.3.6's `xpui-snapshot.css`.
- Data: `youtubei.js` (InnerTube) in the main process, using your YouTube Music cookies.
- Playback: a hidden `music.youtube.com` window. YouTube's own player streams the audio
  (Premium means no ads), and the app sends it commands and reads its state.

```bash
npm install
npm run dev        # hot-reload dev mode
npm run dist       # build dist/mac-arm64/ytspot.app, then install it:
codesign --force --deep -s - dist/mac-arm64/ytspot.app && ditto dist/mac-arm64/ytspot.app /Applications/ytspot.app
```

Closing the window keeps music playing (Dock/Raycast reopens it); ⌘Q quits.

Click **Log in** (top right) once and sign in with your Premium Google account. The session persists.

Shortcuts: Spotify (⌘-based) and YouTube Music (vim-style j/k/h/l, `g h`…) schemes, both on by default; turn either off or rebind in Settings (⌘,). Defaults live in `src/shared/shortcuts.ts`. Press ⌘/ or ? to see them.

Music plays audio-only by default (144p for uploads with no audio-only version); turn on Settings → Music videos or “Switch to video” in Now Playing to watch, and pop the video out with picture-in-picture.
