// Reports from the ⋯ menu (src/ui.tsx ReportSheet), so a report never leaves the app (App Review 1.2).
//   POST /api/report   { fid, hash?, reason, text }: the account, or one of its casts, and why
// Each report is appended to <data>/reports.jsonl first, then POSTed as JSON { text } to REPORT_WEBHOOK, so the
// moderators see every one within 24 hours, and none is lost if the webhook can't be reached for a while.
// A signed-in reporter signs it with one of the account's keys (x-fid, x-key, x-ts, x-sig over
// "quilcast-report:<fid>:<ts>:<body>"), so we know who sent it; signed out, it's anonymous.
// `not_spam` (the ⋯ menu's Not spam, on a cast or account spam.quilcast.com labelled) goes to the owner's Telegram
// through @frdy_bot (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) with the cast's and the account's current scores, so a wrong
// label can be judged at a glance; reports.jsonl keeps them as corrections for the next spam model.
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, parseJson, readText } from './net.mjs'
import { keySigned } from './looks.mjs'

export const REASONS = { spam: 'Spam', abuse: 'Harassment or hate', sexual: 'Sexual content', violence: 'Violence or threats', illegal: 'Illegal', other: 'Other', not_spam: 'Not spam' }
const SPAM = process.env.SPAM_URL || 'https://spam.quilcast.com'
const TELEGRAM = process.env.TELEGRAM_API || 'https://api.telegram.org'
const pct = (s) => (typeof s === 'number' ? `${Math.round(s * 100)}%` : 'not scored yet')
// spam.quilcast.com's scores for the cast and its author; a lookup that fails reads as unknown, never blocks the report
async function scores(fid, hash) {
  const get = (path) => fetch(SPAM + path, { signal: AbortSignal.timeout(3e3) }).then((r) => r.json(), () => ({}))
  const [c, a] = await Promise.all([hash ? get(`/scores?h=${hash}`) : {}, get(`/users?fid=${fid}`)])
  return { cast: hash ? c[hash] : undefined, account: a[fid] }
}
let file = ''
export const loadReports = (dataDir) => (file = join(dataDir, 'reports.jsonl'))

export async function report(req, { node, site, hook = process.env.REPORT_WEBHOOK }) {
  const body = await readText(req, 4e3)
  const r = parseJson(body) || {}
  const fid = Number(r.fid)
  const hash = r.hash == null ? null : String(r.hash).toLowerCase()
  if (!Number.isSafeInteger(fid) || fid <= 0 || (hash !== null && !/^(0x)?[0-9a-f]{40}$/.test(hash)) || !Object.hasOwn(REASONS, r.reason)) throw fail(400, 'bad report')
  const text = String(r.text || '').trim().slice(0, 1000)
  const reporter = Number(req.headers['x-fid'])
  const by = req.headers['x-sig'] ? (await keySigned(req, 'quilcast-report', reporter, body, node), reporter) : null
  const entry = { at: new Date().toISOString(), fid, hash, reason: r.reason, text, by }
  await appendFile(file, JSON.stringify(entry) + '\n')
  if (r.reason === 'not_spam') {
    const s = await scores(fid, hash)
    const lines = [
      `✅ Quilcast: someone says this isn't spam`,
      hash && `Cast: ${site}/c/${hash} (spam ${pct(s.cast)})`,
      `Account: ${site}/u/${fid} (spam account ${pct(s.account)})`,
      `From: ${by ? `${site}/u/${by}` : 'signed out'}`,
      text && `\n${text}`,
      `\nCheck it: ${SPAM}/?c=${hash || ''}`,
    ].filter(Boolean).join('\n')
    const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env
    const send = token && chat
      ? fetch(`${TELEGRAM}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: lines, disable_web_page_preview: true }), signal: AbortSignal.timeout(10e3) })
      : hook && fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: lines }), signal: AbortSignal.timeout(10e3) })
    if (send) await send.then((res) => res.ok || console.error('report: not spam', res.status), (e) => console.error('report: not spam', e.message))
    return { ok: true }
  }
  if (hook) {
    const lines = [
      `🚩 Quilcast report: ${REASONS[r.reason]}`,
      hash ? `Cast: ${site}/c/${hash}` : `Account: ${site}/u/${fid}`,
      `Author: ${site}/u/${fid}`,
      `From: ${by ? `${site}/u/${by}` : 'signed out'}`,
      text && `\n${text}`,
      '\nTake it down: add it to src/removed.json and deploy.',
    ]
    // a failed delivery is logged, not the reporter's problem: the report is already in reports.jsonl
    await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: lines.filter(Boolean).join('\n') }), signal: AbortSignal.timeout(10e3) })
      .then((res) => res.ok || console.error('report: webhook', res.status), (e) => console.error('report: webhook', e.message))
  }
  return { ok: true }
}
