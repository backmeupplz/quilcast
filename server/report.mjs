// Reports from the ⋯ menu (src/ui.tsx ReportSheet), so a report never leaves the app (App Review 1.2).
//   POST /api/report   { fid, hash?, reason, text }: the account, or one of its casts, and why
// Each report is appended to <data>/reports.jsonl first, then POSTed as JSON { text } to REPORT_WEBHOOK, so the
// moderators see every one within 24 hours, and none is lost if the webhook can't be reached for a while.
// A signed-in reporter signs it with one of the account's keys (x-fid, x-key, x-ts, x-sig over
// "quilcast-report:<fid>:<ts>:<body>"), so we know who sent it; signed out, it's anonymous.
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, parseJson, readText } from './net.mjs'
import { keySigned } from './looks.mjs'

export const REASONS = { spam: 'Spam', abuse: 'Harassment or hate', sexual: 'Sexual content', violence: 'Violence or threats', illegal: 'Illegal', other: 'Other' }
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
