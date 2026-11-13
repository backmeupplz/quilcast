// Signing out revokes the key the account's scheduled casts were signed with (write.ts revokeSigner), so the ones still
// waiting would fail at their time with "invalid signer". Settings → Sign out says so first, and cancels them on our
// server before the key goes, so they don't turn up as failed later.

type Item = { id: string; status: string }

/** The scheduled casts signing out would break: the ones still waiting. One being sent right now can't be called back. */
export const waitingToPost = <T extends Item>(list: T[]): T[] => list.filter((s) => s.status === 'scheduled')

/** The waiting casts the prompt knows of: still asking (null), the ids, or 'unknown' when the list couldn't be read. */
export type Waiting = string[] | 'unknown' | null

/** What the sign-out prompt says. A list that couldn't be read is never taken for "nothing scheduled": the prompt says
 *  it couldn't check, so the key isn't revoked without a word. */
export const warning = (w: Waiting): 'checking' | 'none' | 'casts' | 'unchecked' =>
  w === null ? 'checking' : w === 'unknown' ? 'unchecked' : w.length ? 'casts' : 'none'

/** Cancel each one, one after another; answers those that couldn't be, with why (gone already is cancelled). */
export async function cancelAll(ids: string[], cancel: (id: string) => Promise<unknown>): Promise<{ id: string; error: string }[]> {
  const failed: { id: string; error: string }[] = []
  for (const id of ids) await cancel(id).catch((e) => failed.push({ id, error: String(e?.message || e) }))
  return failed
}

export type Confirmed =
  // asked again: casts the prompt didn't name (scheduled meanwhile), or some that couldn't be cancelled (`error`)
  | { state: 'ask'; waiting: string[]; error?: string }
  // the waiting casts are cancelled and the keys revoked
  | { state: 'done' }
  // the waiting casts are cancelled, but the keys couldn't be revoked
  | { state: 'stuck'; error: string }

/** The confirmed sign-out, given the waiting casts the prompt named (`shown`, or 'unknown' when it said it couldn't
 *  check). The list is read again first: casts it didn't name are named before anything goes. The waiting ones are
 *  cancelled, and the keys revoked only once none is left that the revoked key would make fail. A list that can't be
 *  read again goes by what was shown: the casts it named, or none past the "couldn't check" warning just confirmed. */
export async function confirmSignOut(shown: string[] | 'unknown', o: { reread: () => Promise<string[]>; cancel: (id: string) => Promise<unknown>; revoke: () => Promise<void> }): Promise<Confirmed> {
  const named = shown === 'unknown' ? [] : shown
  const now = await o.reread().catch(() => null)
  if (now?.some((id) => !named.includes(id))) return { state: 'ask', waiting: now }
  const failed = await cancelAll(now ?? named, o.cancel)
  // the ones cancelled aren't named again, even when the list can't be read once more
  if (failed.length) return { state: 'ask', waiting: await o.reread().catch(() => failed.map((f) => f.id)), error: failed[0].error }
  try {
    await o.revoke()
    return { state: 'done' }
  } catch (e: any) {
    return { state: 'stuck', error: String(e?.message || e) }
  }
}
