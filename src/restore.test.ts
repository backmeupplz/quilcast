import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allSpots, entry, holding, keepSpot, keepState, lru, navigated, placeKept, showing, spotOf, start, stateOf, takeList } from './restore.ts'

const list = (items: unknown[], cursor: string | null = 'next') => () => ({ items, cursor })

test('lru forgets the entry used longest ago', () => {
  const m = lru<number>(2)
  m.set('a', 1)
  m.set('b', 2)
  m.set('a', 3)
  m.set('c', 4)
  assert.equal(m.get('b'), undefined)
  assert.equal(m.get('a'), 3)
  assert.equal(m.get('c'), 4)
  assert.deepEqual(m.entries(), [['a', 3], ['c', 4]])
})

test('Back hands an entry back the lists it showed when it was left, once', () => {
  start('home1')
  // Home's Following is on screen with 3 posts loaded
  const hide = showing('following', list([1, 2, 3]))
  navigated('cast1', false)
  hide()
  assert.equal(entry(), 'cast1')
  // the cast, opened by a link, has no lists back
  assert.equal(takeList('following'), null)
  navigated('home1', true)
  assert.equal(placeKept(), false)
  assert.deepEqual(takeList('following'), { items: [1, 2, 3], cursor: 'next' })
  assert.equal(placeKept(), true)
  // a list that wasn't on screen when the entry was left loads afresh, and so does one switched away from and back to
  assert.equal(takeList('trending'), null)
  assert.equal(takeList('following'), null)
})

test('each visit to the same page keeps its own lists', () => {
  start('a1')
  let hide = showing('home', list([1, 2, 3, 4, 5, 6]))
  navigated('c1', false)
  hide()
  // a link to Home again: a fresh list, left with one page
  navigated('a2', false)
  hide = showing('home', list([1, 2]))
  navigated('c2', false)
  hide()
  navigated('a2', true)
  assert.deepEqual(takeList('home'), { items: [1, 2], cursor: 'next' })
  hide = showing('home', list([1, 2]))
  navigated('c2', true)
  hide()
  navigated('c1', true)
  navigated('a1', true)
  assert.deepEqual(takeList('home'), { items: [1, 2, 3, 4, 5, 6], cursor: 'next' })
})

test('a link to a page loads its lists afresh, and so does a page left without them', () => {
  start('ch1')
  const hide = showing('channel', list([1], null))
  navigated('c2', false)
  hide()
  navigated('ch2', false)
  assert.equal(takeList('channel'), null)
  // Back onto an entry that showed no lists goes back to its spot
  navigated('c2', true)
  assert.equal(placeKept(), true)
  assert.equal(takeList('channel'), null)
})

test('a list still loading or empty when left is not handed back, and the spot isn\'t either', () => {
  start('e1')
  let hide = showing('loading', () => null)
  navigated('x', false)
  hide()
  navigated('e1', true)
  assert.equal(takeList('loading'), null)
  assert.equal(placeKept(), false)
  hide = showing('empty', list([], null))
  navigated('x', false)
  hide()
  navigated('e1', true)
  assert.equal(takeList('empty'), null)
  assert.equal(placeKept(), false)
})

test('the list read is the one on screen as the entry is left', () => {
  start('l1')
  const items = [1]
  const hide = showing('feed', () => ({ items: [...items], cursor: String(items.length) }))
  items.push(2, 3)
  navigated('l2', false)
  hide()
  navigated('l1', true)
  assert.deepEqual(takeList('feed'), { items: [1, 2, 3], cursor: '3' })
})

test('a Pager gone from the screen is no longer read, and another one\'s cleanup leaves it be', () => {
  start('g1')
  const a = showing('k', list([1]))
  const b = showing('k', list([2]))
  a()
  navigated('g2', false)
  b()
  navigated('g1', true)
  assert.deepEqual(takeList('k'), { items: [2], cursor: 'next' })
})

test('states are kept per entry', () => {
  start('s1')
  keepState('home:', 'trending')
  keepState('round', 2)
  navigated('s2', false)
  assert.equal(stateOf('home:'), undefined)
  assert.equal(stateOf('round'), undefined)
  keepState('home:', 'following')
  navigated('s1', true)
  assert.equal(stateOf('home:'), 'trending')
  assert.equal(stateOf('round'), 2)
  navigated('s2', true)
  assert.equal(stateOf('home:'), 'following')
})

test('scroll spots are kept by entry', () => {
  keepSpot('p1', 1200)
  keepSpot('p2', 40)
  assert.equal(spotOf('p1'), 1200)
  assert.equal(spotOf('p2'), 40)
  assert.equal(spotOf('p3'), 0)
  assert.deepEqual(allSpots().slice(-2), [['p1', 1200], ['p2', 40]])
})

test('what a page holds is read as it\'s left, picked or not', () => {
  start('h1')
  let tab = 'trending'
  const stop = showing('x', list([1]))
  const release = holding('home:', () => tab)
  tab = 'following'
  navigated('h2', false)
  stop()
  release()
  // gone from the screen: no longer read
  tab = 'trending'
  navigated('h3', false)
  navigated('h1', true)
  assert.equal(stateOf('home:'), 'following')
  navigated('h2', true)
  assert.equal(stateOf('home:'), undefined)
})
