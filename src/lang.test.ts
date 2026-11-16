// The detector only has to be right when it speaks; when a cast is short or mixed it should say nothing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DETECTED, detect, keepOld, noTranslate, offersTranslation, togglePick, translatableFrom } from './lang.ts'

test('detect names the language of real-looking casts', () => {
  const casts: [string, string][] = [
    ['gm farcaster! what are you all building this weekend? I just shipped a new client', 'en'],
    ['Hoy es un gran día para construir en Farcaster, ¿qué están haciendo ustedes?', 'es'],
    ['Eu acho que isso é muito legal, você já testou o novo cliente?', 'pt'],
    ["Je pense que c'est une très bonne idée pour la communauté, merci à vous", 'fr'],
    ['Ich habe heute ein neues Projekt gestartet und es ist wirklich toll für die Community', 'de'],
    ['今日は新しいクライアントを試してみました。とても使いやすいです！', 'ja'],
    ['今天天气很好，我们一起去公园散步吧', 'zh'],
    ['오늘 새로운 앱을 만들었어요. 다들 어떻게 생각하세요?', 'ko'],
    ['Сегодня отличный день, чтобы сделать что-нибудь новое', 'ru'],
    ['Сьогодні чудовий день, щоб зробити щось нове і цікаве', 'uk'],
    ['Hôm nay trời đẹp quá, mọi người đi chơi không?', 'vi'],
  ]
  for (const [text, want] of casts) assert.equal(detect(text), want, text)
})

test("detect stays quiet when it can't tell", () => {
  for (const text of ['gm', 'lol 😂😂', 'https://quilcast.com/c/abc @dwr $DEGEN #art', 'Farcaster Quilcast Hypersnap', '🔥🔥🔥 wow'])
    assert.equal(detect(text), null, text)
  // an English cast that mentions a Japanese word is still English
  assert.equal(detect('I love the word 木漏れ日, it means sunlight through the leaves of the trees'), 'en')
})

// #705: Settings → Don't translate from. The app's language is always one of them; the others are picked
const ES = 'Hoy es un gran día para construir en Farcaster, ¿qué están haciendo ustedes?'
const FR = "Je pense que c'est une très bonne idée pour la communauté, merci à vous"

test("a cast in a language the reader doesn't translate from offers nothing, not even a kept translation", () => {
  const reads = noTranslate('en', ['es'])
  // no language to translate from: Said shows no Translate button and asks /api/translations for nothing
  assert.equal(translatableFrom(ES, reads), null)
  assert.equal(offersTranslation(translatableFrom(ES, reads), 'es', reads), false, 'a kept translation is not shown')
  // other languages still offer one, and the app's own never does
  assert.equal(translatableFrom(FR, reads), 'fr')
  assert.equal(offersTranslation('fr', undefined, reads), true)
  assert.equal(offersTranslation('fr', 'fr', reads), true)
  assert.equal(translatableFrom('gm farcaster! what are you all building this weekend? I just shipped a new client', reads), null)
  // without the pick, Spanish offers a translation as before
  assert.equal(translatableFrom(ES, noTranslate('en', [])), 'es')
  // the model found a kept one is in a language the reader reads after all (Spanish here, or with a region)
  assert.equal(offersTranslation('pt', 'es', reads), false)
  assert.equal(offersTranslation('pt', 'en-US', reads), false)
  // the app in Chinese or Brazilian Portuguese reads 'zh' and 'pt' casts
  assert.equal(translatableFrom('今天天气很好，我们一起去公园散步吧', noTranslate('zh-Hant')), null)
  assert.equal(translatableFrom('Eu acho que isso é muito legal, você já testou o novo cliente?', noTranslate('pt-BR')), null)
})

test("the app's language can't be taken off Don't translate from; the others come and go", () => {
  assert.deepEqual([...noTranslate('en')], ['en'], 'nothing picked: the app language alone')
  assert.deepEqual([...noTranslate('en', 'garbage')], ['en'], 'whatever localStorage held')
  assert.deepEqual([...noTranslate('en', ['es', 3, null])], ['en', 'es'])
  assert.deepEqual(togglePick('en', [], 'en'), [], 'tapping the app language changes nothing')
  assert.ok(noTranslate('en', togglePick('en', ['en', 'es'], 'en')).has('en'))
  assert.deepEqual(togglePick('pt-BR', ['es'], 'pt'), ['es'])
  assert.deepEqual(togglePick('en', [], 'es'), ['es'])
  assert.deepEqual(togglePick('en', ['es', 'fr'], 'es'), ['fr'])
  // switching from English to Spanish: English stays picked, and can be taken off now; Spanish is locked in
  const picked = keepOld('en', ['fr'])
  assert.deepEqual(new Set(picked), new Set(['en', 'fr']))
  assert.deepEqual([...noTranslate('es', picked)].sort(), ['en', 'es', 'fr'])
  assert.deepEqual(togglePick('es', picked, 'en'), ['fr'])
  assert.deepEqual(togglePick('es', picked, 'es').sort(), ['en', 'fr'])
})

test('every language detect() can name can be picked', () => {
  const casts = ['Сегодня отличный день, чтобы сделать что-нибудь новое', 'مرحبا بكم جميعا في هذا اليوم الجميل', 'سلام دوستان، امروز چه کار می‌کنید؟ پیچیده', 'Hôm nay trời đẹp quá, mọi người đi chơi không?', ES, FR]
  for (const c of casts) assert.ok(DETECTED.includes(detect(c)!), c)
  assert.equal(new Set(DETECTED).size, DETECTED.length)
})
