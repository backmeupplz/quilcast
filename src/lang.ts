// Which language a cast is in, cheaply and in the browser: by its script for anything not in the Latin alphabet,
// by its most common short words for the Latin-alphabet languages. It answers only when it's fairly sure, so a
// cast it can't place just shows no "Translate" button. (No model: a few KB instead of a classifier like Laya.)

// scripts that name one language (or the one most people write in it), in the order they're checked
const SCRIPTS: [RegExp, string][] = [
  [/[぀-ヿ]/, 'ja'], [/[가-힯ᄀ-ᇿ㄰-㆏]/, 'ko'], [/[㐀-鿿豈-﫿]/, 'zh'],
  [/[Ѐ-ӿ]/, 'cyr'], [/[؀-ۿݐ-ݿ]/, 'arab'], [/[֐-׿]/, 'he'], [/[฀-๿]/, 'th'],
  [/[ऀ-ॿ]/, 'hi'], [/[ঀ-৿]/, 'bn'], [/[஀-௿]/, 'ta'], [/[Ͱ-Ͽ]/, 'el'],
  [/[Ⴀ-ჿ]/, 'ka'], [/[԰-֏]/, 'hy'], [/[a-zÀ-ɏḀ-ỿ]/i, 'latin'],
]

// each language's commonest short words; a word can count for several languages
const WORDS: Record<string, string> = {
  en: 'the and is are to of in that it you for on with this was have be not but what just so my your we they i',
  es: 'el la los las que de y en es por para con una un del pero muy esto también como más lo se no',
  pt: 'o os as que de e em é um uma para com não mais muito isso você eu está são do da no na',
  fr: 'le la les et est des une un pour pas que qui dans avec sur je vous ce cette mais très du au',
  de: 'der die das und ist nicht ein eine ich du mit auf für den dem sich auch wir sie es zu von',
  it: 'il lo la gli che di e è un una per non con sono questo ma molto anche più del della',
  nl: 'de het een en is van dat niet ik je met voor op zijn maar ook wat er naar',
  tr: 've bir bu da de için ne çok ile gibi ama ben sen var yok daha mi',
  id: 'dan yang di ini itu tidak ada aku saya kamu untuk dengan ke dari juga bisa',
  pl: 'i w na nie że to jest się z do jak co ale mnie tak jestem',
  sv: 'och att det är som en på för med inte jag har av till',
}
const SETS = Object.entries(WORDS).map(([l, w]) => [l, new Set(w.split(' '))] as const)

/** The cast's language as an ISO 639-1 code ('zh' for any Chinese), or null when it isn't clear. */
export function detect(text: string): string | null {
  // links, mentions, tickers, tags and emoji say nothing about the language
  const s = text.replace(/https?:\/\/\S+|[@$#/][\w.-]+/g, ' ')
  const count = new Map<string, number>()
  let letters = 0
  for (const ch of s) {
    if (!/\p{L}/u.test(ch)) continue
    letters++
    const k = SCRIPTS.find(([re]) => re.test(ch))?.[1]
    if (k) count.set(k, (count.get(k) || 0) + 1)
  }
  if (letters < 6) return null
  const [top, n] = [...count].sort((a, b) => b[1] - a[1])[0] || ['', 0]
  if (n < letters / 2) return null
  // Japanese mixes in Chinese characters; any kana at all makes it Japanese
  if (top === 'zh' && count.get('ja')) return 'ja'
  if (top === 'cyr') return /[іїєґ]/i.test(s) ? 'uk' : 'ru'
  if (top === 'arab') return /[پچژگ]/.test(s) ? 'fa' : 'ar'
  if (top !== 'latin') return top
  // letters only Vietnamese has (â, ê and ô are Portuguese and French too)
  if (/[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(s)) return 'vi'
  const words = s.toLowerCase().match(/\p{L}+/gu) || []
  const scores = SETS.map(([l, set]) => [l, words.filter((w) => set.has(w)).length] as const).sort((a, b) => b[1] - a[1])
  const [[best, hits], [, next]] = scores
  return hits >= 2 && hits > next * 1.5 ? best : null
}

/** The language Quilcast is in (en, es, ja…), as detect() names it. */
export const base = (l: string) => l.split('-')[0]
