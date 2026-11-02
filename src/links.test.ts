import assert from 'node:assert/strict'
import { test } from 'node:test'
import { domainToUnicode } from 'node:url'
import { lookalike } from './shared.ts'

test('ASCII links open as they are', () => {
  for (const u of ['https://apple.com', 'https://www.apple.com/iphone?x=1#y', 'http://a.b.c.example:8080/', 'https://quilcast.com/u/dwr', 'not a url', ''])
    assert.equal(lookalike(u), '', u)
  // Unicode past the host can't make a link pass for another site
  assert.equal(lookalike('https://ru.wikipedia.org/wiki/Москва'), '')
  assert.equal(lookalike('https://example.com/?q=日本語#été'), '')
  // fullwidth letters fold into plain ASCII on parsing, so the link goes where it reads
  assert.equal(lookalike('https://ａｐｐｌｅ.com'), '')
})

test('a look-alike host is flagged and shown in Unicode', () => {
  assert.equal(lookalike('https://аpple.com'), 'аpple.com') // Cyrillic а
  assert.equal(lookalike('https://αpple.com/login'), 'αpple.com') // Greek α
  assert.equal(lookalike('https://pаypal.com:8443/x'), 'pаypal.com')
  assert.equal(lookalike('https://xn--pple-43d.com/'), 'аpple.com') // already punycode
  assert.equal(lookalike('https://XN--PPLE-43D.COM'), 'аpple.com')
  assert.equal(lookalike('https://login.xn--pple-43d.com'), 'login.аpple.com')
  // any IDN host warns: the sheet shows both forms and the reader decides
  assert.equal(lookalike('https://пример.рф'), 'пример.рф')
  assert.equal(lookalike('https://münchen.de'), 'münchen.de')
  // a label that won't decode (past U+10FFFF, control characters) still warns, shown as it is
  assert.equal(lookalike('https://xn--6c13j0a.com'), 'xn--6c13j0a.com')
  assert.equal(lookalike('https://xn--a.com'), 'xn--a.com')
})

test('Punycode decoding matches the URL module', () => {
  for (const h of ['аpple.com', 'пример.рф', 'münchen.de', '例え.テスト', 'ﻢﺜﺎﻟ.إختبار', 'उदाहरण.परीक्षा', 'i❤.ws', '😀.example', 'xn--a.com', 'straße.de', 'δοκιμή.gr', 'ab-cd.ДЕФ-ghi.com']) {
    const ascii = new URL(`https://${h}`).hostname
    if (!ascii.includes('xn--')) continue
    assert.equal(lookalike(`https://${ascii}/`), domainToUnicode(ascii), h)
  }
})
