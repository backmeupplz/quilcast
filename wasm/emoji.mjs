// Writes wasm/src/emoji.txt, the composer's emoji list (wasm/src/emoji.rs), from the same data quilcast.com's picker
// uses (unicode-emoji-json, src/emoji.tsx): a line with the group's name before each group's emoji, then "emoji<TAB>name" (a line without a tab is a group).
// Run it again after that package is updated: node wasm/emoji.mjs (CI checks the file is up to date).
import { readFile, writeFile } from 'node:fs/promises'

const groups = JSON.parse(await readFile(new URL('../node_modules/unicode-emoji-json/data-by-group.json', import.meta.url), 'utf8'))
const out = groups.map((g) => [g.name, ...g.emojis.map((e) => `${e.emoji}\t${e.name}`)].join('\n')).join('\n') + '\n'
const file = new URL('./src/emoji.txt', import.meta.url)
if (process.argv.includes('--check')) {
  if ((await readFile(file, 'utf8').catch(() => '')) !== out) {
    console.error('wasm/src/emoji.txt is out of date: run node wasm/emoji.mjs')
    process.exit(1)
  }
} else await writeFile(file, out)
