// Writes dist/ytspot-update.json, the file the app's updater reads (src/main/updater.ts) from the
// latest release's public download link. Upload it to every release, next to the zip:
//
//   node scripts/update-manifest.mjs release-notes.md
//   gh release create v1.2.3 dist/ytspot-mac-arm64.zip dist/ytspot-update.json --notes-file release-notes.md
//
// The version comes from package.json, the SHA-256 from dist/ytspot-mac-arm64.zip, and the notes
// (shown in the update dialog) from the Markdown file given, if any.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const sha256 = createHash('sha256').update(readFileSync('dist/ytspot-mac-arm64.zip')).digest('hex')
const notes = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : ''
writeFileSync('dist/ytspot-update.json', JSON.stringify({ version, sha256, notes }, null, 2) + '\n')
console.log(`dist/ytspot-update.json: ${version}, sha256 ${sha256}`)
