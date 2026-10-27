// Translations. The English text is the key: t('Save') looks it up in the language's file (src/locales/<lang>.json,
// loaded before the app renders) and falls back to the English. {name} placeholders are filled from `vars`.
// The language is the one picked in Settings, else the browser's first one we have, else English.
import { settings } from './api.ts'

export const LANGS = {
  en: 'English', ar: 'العربية', de: 'Deutsch', es: 'Español', fr: 'Français', hi: 'हिन्दी', id: 'Bahasa Indonesia', it: 'Italiano', ja: '日本語',
  ko: '한국어', nl: 'Nederlands', pl: 'Polski', 'pt-BR': 'Português (Brasil)', 'pt-PT': 'Português (Portugal)', ru: 'Русский', sv: 'Svenska',
  th: 'ไทย', tr: 'Türkçe', uk: 'Українська', vi: 'Tiếng Việt', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文',
} as const
export type Lang = keyof typeof LANGS
const has = (l: unknown): l is Lang => typeof l === 'string' && Object.hasOwn(LANGS, l)

// Chinese is two languages here: Traditional for Taiwan, Hong Kong and Macau (and zh-Hant), Simplified otherwise.
// Portuguese too: Portugal's (and Africa's) for those, Brazil's for the rest and for plain "pt".
const base = (l: string) =>
  /^zh/i.test(l) ? (/hant|tw|hk|mo/i.test(l) ? 'zh-Hant' : 'zh-Hans') : /^pt/i.test(l) ? (/^pt-(pt|ao|mz|cv|gw|st|tl|mo)\b/i.test(l) ? 'pt-PT' : 'pt-BR') : l.slice(0, 2).toLowerCase()
export const lang: Lang = has(settings.lang) ? settings.lang : (navigator.languages || [navigator.language]).map(base).find(has) || 'en'
/** Arabic is written right to left: the page turns around with it (style.css sticks to logical sides). */
export const rtl = lang === 'ar'

const files: Record<Exclude<Lang, 'en'>, () => Promise<{ default: Record<string, string> }>> = {
  ar: () => import('./locales/ar.json'),
  de: () => import('./locales/de.json'),
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  hi: () => import('./locales/hi.json'),
  id: () => import('./locales/id.json'),
  it: () => import('./locales/it.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  nl: () => import('./locales/nl.json'),
  pl: () => import('./locales/pl.json'),
  'pt-BR': () => import('./locales/pt-BR.json'),
  'pt-PT': () => import('./locales/pt-PT.json'),
  ru: () => import('./locales/ru.json'),
  sv: () => import('./locales/sv.json'),
  th: () => import('./locales/th.json'),
  tr: () => import('./locales/tr.json'),
  uk: () => import('./locales/uk.json'),
  vi: () => import('./locales/vi.json'),
  'zh-Hans': () => import('./locales/zh-Hans.json'),
  'zh-Hant': () => import('./locales/zh-Hant.json'),
}
let dict: Record<string, string> = {}
/** Load the language's strings; the app renders after this. */
export async function loadLang() {
  document.documentElement.lang = lang
  document.documentElement.dir = rtl ? 'rtl' : 'ltr'
  if (lang !== 'en') dict = (await files[lang]().catch(() => ({ default: {} }))).default
}

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : s)
export const t = (s: string, vars?: Record<string, string | number>) => fill(dict[s] || s, vars)

// plural forms in each language's order; the translation holds them joined with "|"
// (a rule a language has but its forms don't, like French "many" for a million, takes the last form)
const two: Intl.LDMLPluralRule[] = ['one', 'other']
const slavic: Intl.LDMLPluralRule[] = ['one', 'few', 'many']
const FORMS: Record<Lang, Intl.LDMLPluralRule[]> = {
  en: two, ar: ['zero', 'one', 'two', 'few', 'many', 'other'], de: two, es: two, fr: two, hi: two, id: ['other'], it: two, ja: ['other'], ko: ['other'],
  nl: two, pl: slavic, 'pt-BR': two, 'pt-PT': two, ru: slavic, sv: two, th: ['other'], tr: two, uk: slavic, vi: ['other'], 'zh-Hans': ['other'], 'zh-Hant': ['other'],
}
const rules = new Intl.PluralRules(lang)
/** A count with its word: tn(3, '{n} reply', '{n} replies'). */
export function tn(n: number, one: string, other: string, vars?: Record<string, string | number>) {
  const forms = (dict[`${one}|${other}`] || `${one}|${other}`).split('|')
  const order = dict[`${one}|${other}`] ? FORMS[lang] : FORMS.en
  const i = order.indexOf(rules.select(n))
  return fill(forms[i < 0 ? forms.length - 1 : Math.min(i, forms.length - 1)], { n, ...vars })
}
