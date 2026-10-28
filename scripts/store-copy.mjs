// Checks the store texts against the stores' limits: every appstore/<locale>/listing.md (en-US is appstore/listing.md)
// and its Play folder, fastlane/metadata/android/<Play code>/ (title, short and full description, changelogs).
// Keywords never repeat a word of the name or subtitle, and App Store text never names another platform (guideline 2.3.10).
import { existsSync, readdirSync, readFileSync } from 'node:fs'

// App Store locales whose Play folder has another name (.github/scripts/notes.py maps the same codes, plus languages without a listing yet)
const PLAY = { 'es-MX': 'es-419', it: 'it-IT', ru: 'ru-RU', pl: 'pl-PL', tr: 'tr-TR', ja: 'ja-JP', ko: 'ko-KR', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', 'ar-SA': 'ar', hi: 'hi-IN', sv: 'sv-SE' }
// Every limit counts characters. For keywords App Store Connect's reference says "up to 100 bytes", but App Store Connect
// counts characters: it holds Todorant's ru and uk keywords at 91 and 92 characters, which are 169 and 171 UTF-8 bytes, on
// every version from 2.2.0 to 2.2.11 (read through its API on 2026-10-28, #238)
const LIMITS = { Name: 30, Subtitle: 30, 'Promotional text': 170, Keywords: 100, Description: 4000, 'Feature graphic tagline': 60 }
// in Latin letters and the usual spellings in the listings' own scripts
const PLATFORMS = /android|\bgoogle\b|google ?play|f-droid|fdroid|\bapk\b|play store|安卓|アンドロイド|안드로이드|андроид|андроїд|أندرويد|एंड्रॉइड|एंड्रॉयड|اندرويد|แอนดรอยด์|구글|グーグル|谷歌|гугл|плей ?маркет|play ?(?:market|маркет|ストア|스토어|商店)|متجر ?play|गूगल|جوجل|غوغل|กูเกิล/i
const CAPTION = 40 // two lines under a phone screenshot
// Which of our localizations each storefront indexes, from Apple's table at
// https://developer.apple.com/help/app-store-connect/reference/app-information/app-store-localizations (checked 2026-10-27).
// Languages we have no listing in (Catalan, Greek, fr-CA…) are left out.
const STOREFRONTS = {
  // Canada (CAN) indexes only en-CA and fr-CA, neither of which we ship, so it indexes none of our localizations and is left out
  'GBR and every storefront not below except CAN': ['en-GB'],
  USA: ['en-US', 'ar-SA', 'zh-Hans', 'zh-Hant', 'fr-FR', 'ko', 'pt-BR', 'ru', 'es-MX', 'vi'],
  JPN: ['ja', 'en-US'],
  'DZA EGY LBN MAR MRT TUN': ['en-GB', 'ar-SA', 'fr-FR'],
  'ARE BHR IRQ JOR KWT LBY OMN QAT SAU YEM': ['en-GB', 'ar-SA'],
  'ARG BLZ BOL CHL COL CRI DOM ECU GTM HND MEX NIC PAN PER PRY SLV URY VEN': ['es-MX', 'en-GB'],
  'AUT DEU': ['de-DE', 'en-GB'],
  BEL: ['en-GB', 'nl-NL', 'fr-FR'],
  'BEN BFA CIV CMR COD COG FRA GAB GNB GUY KHM LAO MDG MLI MUS NER RWA SEN SYC TCD TTO VUT': ['fr-FR', 'en-GB'],
  BRA: ['pt-BR', 'en-GB'],
  'CHN SGP': ['zh-Hans', 'en-GB'],
  'CYP TUR': ['tr', 'en-GB'],
  'HKG MAC TWN': ['zh-Hant', 'en-GB'],
  IND: ['hi', 'en-GB'],
  IDN: ['id', 'en-GB'],
  ITA: ['it', 'en-GB'],
  KOR: ['ko', 'en-GB'],
  LUX: ['en-GB', 'fr-FR', 'de-DE'],
  'NLD SUR': ['nl-NL', 'en-GB'],
  POL: ['pl', 'en-GB'],
  PRT: ['pt-PT', 'en-GB'],
  'RUS UKR': ['ru', 'en-GB', 'uk'],
  ESP: ['es-ES', 'en-GB'],
  SWE: ['sv', 'en-GB'],
  CHE: ['de-DE', 'en-GB', 'fr-FR', 'it'],
  THA: ['th', 'en-GB'],
  VNM: ['vi', 'en-GB'],
}

const errors = []
const indexed = {} // locale → the words its name, subtitle and keywords make searchable, and its keyword terms
const fail = (locale, message) => errors.push(`${locale}: ${message}`)
// Latin glued to another script ("farcasterクライアント") is two words
const OTHER = '\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}ー\\p{sc=Hangul}\\p{sc=Thai}\\p{sc=Arabic}\\p{sc=Devanagari}\\p{sc=Cyrillic}'
const GLUED = new RegExp(`([\\p{sc=Latin}\\d])(?=[${OTHER}])|([${OTHER}])(?=[\\p{sc=Latin}\\d])`, 'gu')
const words = (text) => text.toLowerCase().replace(GLUED, '$1$2 ').split(/[\s:,&·\-–—/|]+/).filter(Boolean)

function sections(text) {
  const out = {}
  let name
  for (const line of text.split('\n')) {
    const m = line.match(/^## (.+?)(?: \(max \d+\))?$/)
    if (m) out[(name = m[1])] = []
    else if (name) out[name].push(line)
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]))
}

function listing(locale, file) {
  const s = sections(readFileSync(file, 'utf8'))
  for (const [key, limit] of Object.entries(LIMITS)) {
    if (!s[key]) fail(locale, `no ${key}`)
    else if ([...s[key]].length > limit) fail(locale, `${key} is ${[...s[key]].length} characters, the limit is ${limit}`)
  }
  if (!s.Name?.startsWith('Quilcast')) fail(locale, 'the name starts with Quilcast')
  const keywords = s.Keywords ?? ''
  if (/,\s|\s,/.test(keywords)) fail(locale, 'keywords have spaces around commas (they cost characters)')
  if (/[，、،]/.test(keywords)) fail(locale, 'keywords are separated by ASCII commas')
  if (/,,|^,|,$/.test(keywords)) fail(locale, 'keywords have an empty term')
  const terms = keywords.split(',').filter(Boolean)
  if (new Set(terms.map((t) => t.toLowerCase())).size !== terms.length) fail(locale, 'a keyword is there twice')
  const title = `${s.Name} ${s.Subtitle}`.toLowerCase()
  const taken = new Set(words(title))
  for (const term of terms) {
    // a word already in the name or subtitle is indexed already; scripts without spaces are matched as text, so a
    // longer keyword holding a shorter word of the name (去中心化社交网络 next to 去中心化社交) is left to the reader
    for (const w of words(term)) if (taken.has(w) || (/[^\x00-\x7f]/.test(w) && title.includes(w))) fail(locale, `keyword "${term}" repeats "${w}" from the name or subtitle`)
  }
  indexed[locale] = { all: new Set([...taken, ...terms.flatMap(words)]), terms }
  for (const key of ['Name', 'Subtitle', 'Promotional text', 'Keywords', 'Description', 'Screenshot captions']) {
    const m = (s[key] ?? '').match(PLATFORMS)
    if (m) fail(locale, `${key} mentions another platform ("${m[0]}")`)
  }
  const captions = (s['Screenshot captions'] ?? '').split('\n').filter((c) => c.trim()).map((c) => c.replace(/^\d+\.\s*/, ''))
  if (captions.length !== 5) fail(locale, `${captions.length} screenshot captions, one per screenshot is 5`)
  for (const c of captions) if ([...c].length > CAPTION) fail(locale, `caption "${c}" is ${[...c].length} characters, the limit is ${CAPTION}`)
}

function play(locale, dir) {
  for (const [name, limit] of [['title.txt', 30], ['short_description.txt', 80], ['full_description.txt', 4000]]) {
    if (!existsSync(`${dir}/${name}`)) { fail(locale, `no ${dir}/${name}`); continue }
    const text = readFileSync(`${dir}/${name}`, 'utf8')
    if (!/[^\n]\n$/.test(text)) fail(locale, `${name} ends with exactly one newline`)
    if ([...text.trimEnd()].length > limit) fail(locale, `${name} is ${[...text.trimEnd()].length} characters, the limit is ${limit}`)
    if (/<[a-z/]/i.test(text)) fail(locale, `${name} has markup`)
  }
  if (existsSync(`${dir}/changelogs`)) {
    for (const f of readdirSync(`${dir}/changelogs`)) {
      const n = [...readFileSync(`${dir}/changelogs/${f}`, 'utf8').trim()].length
      if (n > 500) fail(locale, `changelogs/${f} is ${n} characters, Play's limit is 500`)
    }
  }
}

const file = (locale) => (locale === 'en-US' ? 'appstore/listing.md' : `appstore/${locale}/listing.md`)
const locales = ['en-US', ...readdirSync('appstore', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)].filter((l) => existsSync(file(l)))
// every localization STOREFRONTS names has a listing, so deleting one fails here instead of passing with fewer languages
// (and the keyword check below skipping it)
for (const locale of new Set(Object.values(STOREFRONTS).flat())) if (!locales.includes(locale)) fail(locale, `no ${file(locale)}`)
for (const locale of locales) {
  listing(locale, file(locale))
  play(locale, `fastlane/metadata/android/${PLAY[locale] ?? locale}`)
}
// a keyword that other localizations already carry in every storefront indexing this one takes up space for nothing;
// Apple doesn't document joining words across localizations, so to be safe a multi-word term is kept whole when one of its words is
// new ("mini uygulama" keeps its "mini")
const storefronts = Object.values(STOREFRONTS)
for (const locale of locales) {
  const where = storefronts.filter((s) => s.includes(locale))
  if (!where.length) { fail(locale, 'no storefront in STOREFRONTS indexes this locale'); continue }
  for (const term of indexed[locale].terms) {
    const from = where.map((s) => s.filter((l) => l !== locale && words(term).every((w) => indexed[l]?.all.has(w))))
    if (from.every((o) => o.length)) fail(locale, `keyword "${term}" is already in ${[...new Set(from.flat())].join(', ')} wherever ${locale} is indexed`)
  }
}
// every Play folder belongs to a listing, so F-Droid and Play never get a language the App Store lacks
const folders = new Set(locales.map((l) => PLAY[l] ?? l))
for (const d of readdirSync('fastlane/metadata/android', { withFileTypes: true })) if (d.isDirectory() && !folders.has(d.name)) fail(d.name, 'a Play folder without appstore/<locale>/listing.md')

console.log(errors.length ? errors.join('\n') : `${locales.length} store languages ok`)
process.exit(errors.length ? 1 : 0)
