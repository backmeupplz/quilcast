// Translations. The English text is the key: t('Save') looks it up in the language's file (src/locales/<lang>.json,
// loaded before the app renders) and falls back to the English. {name} placeholders are filled from `vars`.
// The language is the one picked in Settings, else the browser's first one we have, else English.
import { settings } from './api.ts'

export const LANGS = { en: 'English', es: 'Español', ja: '日本語', ru: 'Русский', uk: 'Українська', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文' } as const
export type Lang = keyof typeof LANGS
const has = (l: unknown): l is Lang => typeof l === 'string' && Object.hasOwn(LANGS, l)

// Chinese is two languages here: Traditional for Taiwan, Hong Kong and Macau (and zh-Hant), Simplified otherwise
const base = (l: string) => (/^zh/i.test(l) ? (/hant|tw|hk|mo/i.test(l) ? 'zh-Hant' : 'zh-Hans') : l.slice(0, 2).toLowerCase())
export const lang: Lang = has(settings.lang) ? settings.lang : (navigator.languages || [navigator.language]).map(base).find(has) || 'en'

const files: Record<Exclude<Lang, 'en'>, () => Promise<{ default: Record<string, string> }>> = {
  es: () => import('./locales/es.json'),
  ja: () => import('./locales/ja.json'),
  ru: () => import('./locales/ru.json'),
  uk: () => import('./locales/uk.json'),
  'zh-Hans': () => import('./locales/zh-Hans.json'),
  'zh-Hant': () => import('./locales/zh-Hant.json'),
}
let dict: Record<string, string> = {}
/** Load the language's strings; the app renders after this. */
export async function loadLang() {
  document.documentElement.lang = lang
  if (lang !== 'en') dict = (await files[lang]().catch(() => ({ default: {} }))).default
}

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m)) : s)
export const t = (s: string, vars?: Record<string, string | number>) => fill(dict[s] || s, vars)

// plural forms in each language's order; the translation holds them joined with "|"
const FORMS: Record<Lang, Intl.LDMLPluralRule[]> = { en: ['one', 'other'], es: ['one', 'other'], ja: ['other'], ru: ['one', 'few', 'many'], uk: ['one', 'few', 'many'], 'zh-Hans': ['other'], 'zh-Hant': ['other'] }
const rules = new Intl.PluralRules(lang)
/** A count with its word: tn(3, '{n} reply', '{n} replies'). */
export function tn(n: number, one: string, other: string, vars?: Record<string, string | number>) {
  const forms = (dict[`${one}|${other}`] || `${one}|${other}`).split('|')
  const order = dict[`${one}|${other}`] ? FORMS[lang] : FORMS.en
  const i = order.indexOf(rules.select(n))
  return fill(forms[i < 0 ? forms.length - 1 : Math.min(i, forms.length - 1)], { n, ...vars })
}
