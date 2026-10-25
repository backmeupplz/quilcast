// The detector only has to be right when it speaks; when a cast is short or mixed it should say nothing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detect } from './lang.ts'

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
