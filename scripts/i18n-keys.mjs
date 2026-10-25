// Lists every string the app can translate: t('…') and tn('…', '…') calls, plus English text that reaches toast()
// as is (toast and thrown errors, including the server's). `node scripts/i18n-keys.mjs` prints them as JSON;
// `--check` fails when a language file misses a key, has one that's gone, or drops a {placeholder}.
import { readdirSync, readFileSync } from 'node:fs'

const read = (dir, re) => readdirSync(dir).filter((f) => re.test(f) && !f.includes('.test.')).map((f) => readFileSync(`${dir}/${f}`, 'utf8'))
const src = read('src', /\.tsx?$/)
const server = read('server', /\.mjs$/)
const lit = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"`
const str = (m, i) => (m[i] ?? m[i + 1]).replace(/\\(.)/g, '$1')
const keys = new Set()
const all = (text, re, f) => [...text.matchAll(re)].forEach(f)
for (const s of src) {
  all(s, new RegExp(String.raw`\b(?:t|tr)\(\s*(?:${lit})`, 'g'), (m) => keys.add(str(m, 1)))
  all(s, new RegExp(String.raw`\btn\([^,]+,\s*(?:${lit})\s*,\s*(?:${lit})`, 'g'), (m) => keys.add(`${str(m, 1)}|${str(m, 3)}`))
  all(s, new RegExp(String.raw`\b(?:toast\(|new Error\(|rpcError\(\d+,)\s*(?:${lit})`, 'g'), (m) => keys.add(str(m, 1)))
}
// the server's errors are shown in the app's toasts
// (lowercase ones like 'bad json' are API replies no person sees)
for (const s of server) all(s, new RegExp(String.raw`\b(?:fail\(\d+,|error:)\s*(?:${lit})`, 'g'), (m) => /^[A-Z]/.test(str(m, 1)) && keys.add(str(m, 1)))

// labels kept in English in module-level lists and translated where they're shown: t(label)
const LABELS = [
  // server/translate.mjs's messages, shown by toast()
  'Too many translations at once, try again in a few minutes.', "Translation isn't set up on this server yet.", 'That cast has no words to translate.', 'The free translator is busy. Try again in a minute.',
  // the Winamp (amp.tsx): side buttons, visualizations, equalizer presets, playlist buttons
  'Options', 'Always on top', 'Track info on YouTube', 'Double size', 'Visualization', 'Spectrum analyzer', 'Oscilloscope', 'No visualization',
  'Flat', 'Classical', 'Club', 'Dance', 'Full bass', 'Full treble', 'Pop', 'Rock', 'Techno', 'Add', 'Remove', 'Select', 'Misc', 'List',
  'Previous', 'Play', 'Pause', 'Stop', 'Next', 'Play a YouTube link…',
  'Classic', 'Emo night', 'Glitter', 'Scene kid', 'Y2K chrome', 'Swamp',
  'System', 'Verdana', 'Arial', 'Trebuchet', 'Georgia', 'Times', 'Courier', 'Comic Sans', 'Impact', 'Rounded', 'Console',
  'General', 'Music', 'Movies', 'Television', 'Books', 'Heroes',
  'Tiled', 'Fill the screen', 'Centered once',
  'Solid', 'Dashed', 'Dotted', 'Double', 'Groove', 'Ridge', 'None', 'Rainbow', 'Glow', 'Shadow', 'Outline', 'Small', 'Normal', 'Large',
  'Snow', 'Snowflakes', 'Rain', 'Thunderstorm', 'Autumn leaves', 'Cherry blossoms', 'Confetti', 'Floating hearts', 'Bubbles', 'Twinkling stars', 'Glitter', 'Fireflies', 'Embers', 'Bokeh',
  'Shooting stars', 'Fireworks', 'Matrix code', 'Make it rain', 'Pizza', 'Balloons', 'Bats', 'Ghosts', 'Spooky', 'Butterflies', 'Music notes', 'Emoji rain', 'Sparkle cursor',
  'Never', 'After a day', 'After a week', 'After 30 days', 'After a year',
  'No messages yet. Start one from someone’s profile.', 'Nothing unread.', 'No message requests.', 'No muted conversations.',
]
LABELS.forEach((k) => keys.add(k))
const list = [...keys].filter((k) => /[a-z]/i.test(k)).sort()
if (!process.argv.includes('--check')) {
  console.log(JSON.stringify(list, null, 2))
} else {
  let bad = 0
  const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join()
  for (const f of readdirSync('src/locales').filter((f) => f.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(`src/locales/${f}`, 'utf8'))
    const missing = list.filter((k) => !d[k])
    const stale = Object.keys(d).filter((k) => !keys.has(k))
    const broken = list.filter((k) => d[k] && new Set(d[k].split('|').map(holes)).size > 1 || (d[k] && holes(d[k].split('|')[0]) !== holes(k.split('|')[0])))
    if (missing.length || stale.length || broken.length) bad++
    console.log(`${f}: ${list.length - missing.length}/${list.length}` + (missing.length ? `, missing ${JSON.stringify(missing.slice(0, 5))}…` : '') + (stale.length ? `, stale ${JSON.stringify(stale.slice(0, 5))}` : '') + (broken.length ? `, placeholders differ ${JSON.stringify(broken.slice(0, 5))}` : ''))
  }
  process.exit(bad ? 1 : 0)
}
