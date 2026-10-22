// Profile looks: MySpace-style customization of profile pages (background, colors, font, boxes, name effects,
// mood, profile song, blurbs, interests, top friends, a GIF wall). Kept on our server (server/looks.mjs), checked
// by cleanLook (shared.ts) on the way in and out, and shown only on profile pages unless Settings turns them off.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { findUsers, loadUsers, users, type User } from './api.ts'
import { cleanDesign, cleanLook, DESIGN_KEYS, lookVars, designId, FONTS, INTERESTS, isLookImg, LIMITS, NAME_FX, BORDERS, BG_MODES, SIZES, sized, type Look } from './shared.ts'
import { Avatar, designOf, Icon, Img, nameOf, RichText, shell, toast, userPath, w } from './ui.tsx'

export const clean = cleanLook

/** `l` wearing a shared design: its style is replaced, its words, friends, GIF wall and song stay. */
export const withDesign = (l: Look, d: Look): Look => ({ ...l, ...Object.fromEntries(DESIGN_KEYS.map((k) => [k, undefined])), ...d })

// --- showing a look ---

/** The look's colors and font as CSS variables on the profile's wrapper; the app's styles take them from there. */
export const vars = lookVars

/** The page background, a layer behind everything while the profile is open. */
export const Bg = ({ l }: { l: Look }) =>
  l.bg || l.bgImg ? (
    <div class={`lk-bg ${l.bgMode || 'tile'}`} aria-hidden="true"
      style={{ backgroundColor: l.bg, backgroundImage: l.bgImg ? `url("${l.bgImg}")` : undefined, '--lk-dim': l.bgDim ? String(l.bgDim / 100) : undefined }} />
  ) : null

export const nameClass = (l?: Look | null) => (l?.nameFx && l.nameFx !== 'none' ? `lk-name ${l.nameFx}` : undefined)

export const Banner = ({ l }: { l: Look }) => (l.banner ? <Img class="lk-banner" src={l.banner} /> : null)
export const Mood = ({ l }: { l: Look }) => (l.mood || l.moodEmoji ? <div class="lk-mood"><b>Mood:</b> {l.moodEmoji} {l.mood}</div> : null)

const Box = ({ title, children, class: cls = '' }: { title: string; children: ComponentChildren; class?: string }) => (
  <section class={`lk-box lk-sec ${cls}`}><h3>{title}</h3>{children}</section>
)

/** The look's own sections, between the profile header and the casts. */
export function Sections({ l, u }: { l: Look; u: User }) {
  const who = nameOf(u)
  const ints = Object.entries(l.interests || {}) as [keyof typeof INTERESTS, string][]
  return (
    <>
      {l.song && <Song s={l.song} />}
      {l.about && <Box title="About me"><RichText text={l.about} /></Box>}
      {l.meet && <Box title="Who I'd like to meet"><RichText text={l.meet} /></Box>}
      {ints.length > 0 && (
        <Box title={`${who}'s Interests`}>
          <dl class="lk-int">{ints.map(([k, t]) => <><dt>{INTERESTS[k]}</dt><dd><RichText text={t} /></dd></>)}</dl>
        </Box>
      )}
      {l.top && <Top fids={l.top} title={l.topTitle || `${who}'s Top ${l.top.length}`} />}
      {l.wall && <Box title={l.wallTitle || 'GIFs'}><div class="lk-wall">{l.wall.map((src) => <Img src={src} />)}</div></Box>}
    </>
  )
}

function Top({ fids, title }: { fids: number[]; title: string }) {
  const [, force] = useState(0)
  useEffect(() => void loadUsers(fids).then(() => force((x) => x + 1)), [fids.join()])
  return (
    <Box title={title}>
      <div class="lk-top">
        {fids.map((f) => users.get(f)).filter((u): u is User => !!u).map((u) => (
          <a href={userPath(u)}><Avatar u={u} size={64} link={false} /><span>{nameOf(u)}</span></a>
        ))}
      </div>
    </Box>
  )
}

// the song plays in YouTube's own player, and only when the visitor asks for it
function Song({ s }: { s: NonNullable<Look['song']> }) {
  const [on, setOn] = useState(false)
  useEffect(() => setOn(false), [s.id, s.start])
  return (
    <Box title="Profile song" class="lk-song">
      {on ? (
        <iframe src={`https://www.youtube-nocookie.com/embed/${s.id}?autoplay=1&playsinline=1${s.start ? `&start=${s.start}` : ''}`} title={s.title || 'Profile song'}
          allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowFullScreen />
      ) : (
        <button class="lk-play" onClick={() => setOn(true)}><span aria-hidden="true">▶︎</span><b>{s.title || 'Play the song'}</b></button>
      )}
    </Box>
  )
}

// --- editing ---

// each preset sets every style field and leaves the images and the words alone
const STYLE: Look = { bg: undefined, text: undefined, muted: undefined, link: undefined, box: undefined, boxAlpha: undefined, border: undefined, borderStyle: undefined, borderWidth: undefined, radius: undefined, font: undefined, size: undefined, nameFx: undefined, nameColor: undefined }
const PRESETS: [string, Look][] = [
  ['Classic', { bg: '#e5ecf9', text: '#000000', muted: '#555555', link: '#003399', box: '#ffffff', boxAlpha: 100, border: '#6699cc', borderStyle: 'solid', borderWidth: 1, radius: 0, font: 'verdana', size: 'small', nameFx: 'none' }],
  ['Emo night', { bg: '#000000', text: '#f2f2f2', muted: '#9a9a9a', link: '#ff2e88', box: '#111111', boxAlpha: 90, border: '#ff2e88', borderStyle: 'dashed', borderWidth: 2, radius: 0, font: 'courier', nameFx: 'glow', nameColor: '#ff2e88' }],
  ['Glitter', { bg: '#ffd6ec', text: '#5a0838', muted: '#a0507c', link: '#e0007a', box: '#fff0f8', boxAlpha: 85, border: '#ff8ac6', borderStyle: 'dotted', borderWidth: 3, radius: 18, font: 'comic', nameFx: 'glitter', nameColor: '#ff3fa4' }],
  ['Scene kid', { bg: '#14001f', text: '#e9ffe0', muted: '#9fd48a', link: '#39ff14', box: '#24003a', boxAlpha: 85, border: '#ff00e6', borderStyle: 'double', borderWidth: 4, radius: 6, font: 'impact', nameFx: 'rainbow' }],
  ['Y2K chrome', { bg: '#c9d3e0', text: '#1a2233', muted: '#4c5a70', link: '#0057d9', box: '#eef2f8', boxAlpha: 92, border: '#8a9ab3', borderStyle: 'ridge', borderWidth: 4, radius: 12, font: 'trebuchet', nameFx: 'outline', nameColor: '#0057d9' }],
  ['Swamp', { bg: '#1c2a0c', text: '#e4eecb', muted: '#98a67a', link: '#9acd32', box: '#172010', boxAlpha: 88, border: '#4f6b00', borderStyle: 'groove', borderWidth: 3, radius: 14, font: 'rounded', nameFx: 'shadow', nameColor: '#7cb518' }],
]
const FONT_NAMES: Record<keyof typeof FONTS, string> = { system: 'System', verdana: 'Verdana', arial: 'Arial', trebuchet: 'Trebuchet', georgia: 'Georgia', times: 'Times', courier: 'Courier', comic: 'Comic Sans', impact: 'Impact', rounded: 'Rounded', pixel: 'Console' }
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

// a YouTube link (watch, youtu.be, shorts, embed) and its start time (t=95, t=1m35s)
const ytId = (s: string) => (s.match(/(?:youtu\.be\/|[?&]v=|\/(?:embed|shorts|live)\/)([\w-]{11})/) || s.trim().match(/^([\w-]{11})$/))?.[1]
const ytStart = (s: string) => {
  const m = s.match(/[?&](?:t|start)=(?:(\d+)m)?(\d+)s?\b/)
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : undefined
}

type Set = (f: (d: Look) => Look) => void
type Pick = { pick: (url: string) => void }

export function Editor({ draft: d, set, close, saved }: { draft: Look; set: Set; close: () => void; saved: (l: Look | null) => void }) {
  const [min, setMin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [gif, setGif] = useState<Pick | null>(null)
  const [song, setSong] = useState(d.song ? `https://youtu.be/${d.song.id}${d.song.start ? `?t=${d.song.start}` : ''}` : '')
  const [q, setQ] = useState('')
  const [link, setLink] = useState('')
  const [found, setFound] = useState<User[]>([])
  const file = useRef<HTMLInputElement>(null)
  const onFile = useRef<(u: string) => void>(() => {})
  const up = (p: Look) => set((x) => ({ ...x, ...p }))

  useEffect(() => {
    if (!q.trim()) return setFound([])
    let live = true
    const t = setTimeout(() => findUsers(q.trim()).then((r) => live && setFound(r.slice(0, 6)), () => {}), 300)
    return () => ((live = false), clearTimeout(t))
  }, [q])

  const upload = (then: (u: string) => void) => ((onFile.current = then), file.current?.click())
  const gotFile = async (f?: File) => {
    if (!f) return
    toast('Uploading…')
    try {
      // the CDN serves any width, so a background never needs the full original
      const url = sized(await (await w()).upload(f), 'w=1600')
      if (!isLookImg(url)) throw new Error("That image can't be used here.")
      onFile.current(url)
    } catch (e: any) {
      toast(e.message)
    }
  }
  const save = async () => {
    setBusy(true)
    try {
      const l = cleanLook(d)
      const r = await (await w()).saveLook(Object.keys(l).length ? l : null)
      saved(r ? cleanLook(r) : null)
      toast('Your profile look is saved')
    } catch (e: any) {
      toast(e.message)
    }
    setBusy(false)
  }

  const load = async () => {
    const des = await designOf(designId(link)!)
    if (!des) return toast("That design link doesn't work.")
    set((x) => withDesign(x, des))
    setLink('')
    toast('Design loaded. Save to keep it.')
  }
  // sharing stores the design and gives its link: in a new cast, where it shows a "Use this design" button, or copied
  const designLink = async () => {
    const des = cleanDesign(d)
    if (!Object.keys(des).length) throw new Error('Pick some colors or a background first.')
    const r = await fetch('/api/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(des) })
    const j = await r.json().catch(() => null)
    if (!r.ok || !j?.id) throw new Error(j?.error || 'Sharing failed.')
    return `${location.origin}/design/${j.id}`
  }
  const castIt = () => designLink().then((url) => shell.compose({ embeds: [url] }), (e) => toast(e.message))
  // Safari only lets a click write the clipboard if the write starts right away, so the link goes in as a promise
  const copy = () => {
    const url = designLink()
    const done = typeof ClipboardItem !== 'undefined'
      ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': url.then((u) => new Blob([u], { type: 'text/plain' })) })])
      : url.then((u) => navigator.clipboard.writeText(u))
    done.then(() => toast('Link copied'), () => url.then(() => toast("Couldn't copy the link."), (e) => toast(e.message)))
  }

  // controls are plain functions, not components, so typing or dragging doesn't remount them
  const row = (label: string, ctl: ComponentChildren) => <label class="lk-row"><span>{label}</span><span class="lk-ctl">{ctl}</span></label>
  const clear = (k: keyof Look, label: string) => d[k] !== undefined && <button type="button" class="lk-x" aria-label={`Reset ${label}`} onClick={(e) => (e.preventDefault(), up({ [k]: undefined }))}>×</button>
  const color = (k: 'bg' | 'text' | 'muted' | 'link' | 'box' | 'border' | 'nameColor', label: string, fallback: string) =>
    row(label, <><input type="color" value={d[k] || fallback} onInput={(e) => up({ [k]: e.currentTarget.value })} />{clear(k, label)}</>)
  const range = (k: 'bgDim' | 'boxAlpha' | 'borderWidth' | 'radius', label: string, min: number, max: number, fallback: number, unit = '') =>
    row(label, <><input type="range" min={min} max={max} value={d[k] ?? fallback} onInput={(e) => up({ [k]: Number(e.currentTarget.value) })} /><output>{d[k] ?? fallback}{unit}</output></>)
  const select = (k: 'bgMode' | 'borderStyle' | 'font' | 'size' | 'nameFx', label: string, options: readonly string[], names: Record<string, string> = {}) =>
    row(label, <select value={d[k] || ''} onChange={(e) => up({ [k]: e.currentTarget.value || undefined })}><option value="">Default</option>{options.map((o) => <option value={o}>{names[o] || cap(o)}</option>)}</select>)
  const text = (k: 'mood' | 'moodEmoji' | 'about' | 'meet' | 'topTitle' | 'wallTitle', label: string, max: number, ph = '', area = false) => {
    const p = { value: d[k] || '', maxLength: max, placeholder: ph, onInput: (e: { currentTarget: { value: string } }) => up({ [k]: e.currentTarget.value || undefined }) }
    return <label class="field"><span>{label}</span>{area ? <textarea rows={4} {...p} /> : <input {...p} />}</label>
  }
  const image = (k: 'bgImg' | 'banner', label: string) => (
    <div class="lk-row"><span>{label}</span><span class="lk-ctl">
      {d[k] && <Img class="lk-thumb" src={d[k]} />}
      <button type="button" class="btn ghost small" onClick={() => setGif({ pick: (u) => up({ [k]: u }) })}>GIF</button>
      <button type="button" class="btn ghost small" onClick={() => upload((u) => up({ [k]: u }))}>Upload</button>
      {clear(k, label)}
    </span></div>
  )
  const addWall = (u: string) => set((x) => ({ ...x, wall: [...new Set([...(x.wall || []), u])].slice(0, LIMITS.wall) }))
  const group = (title: string, body: ComponentChildren, open = false) => <details class="lk-group" open={open}><summary>{title}</summary>{body}</details>

  return (
    <div class={`lk-edit${min ? ' min' : ''}`} role="dialog" aria-label="Customize your profile">
      <div class="lk-edit-head">
        <button class="icon-btn" onClick={() => setMin(!min)} aria-label={min ? 'Show the editor' : 'Hide the editor'} aria-expanded={!min}><Icon d={min ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'} size={20} /></button>
        <b>Customize</b>
        <button class="btn ghost small" onClick={close}>Cancel</button>
        <button class="btn small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => (gotFile(e.currentTarget.files?.[0]), (e.currentTarget.value = ''))} />
      {/* the editor stays mounted under the picker, so its open groups and scroll survive a pick */}
      {gif && <GifPicker pick={(u) => (gif.pick(u), setGif(null))} close={() => setGif(null)} />}
      <div class="lk-edit-body" hidden={!!gif}>
        {group('Layouts', <>
          <div class="lk-presets">{PRESETS.map(([name, p]) => <button class="btn ghost small" onClick={() => up({ ...STYLE, ...p })}>{name}</button>)}</div>
          <div class="lk-design">
            <input value={link} placeholder="Paste a design link" aria-label="Design link" onInput={(e) => setLink(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && designId(link) && load()} />
            <button class="btn ghost small" disabled={!designId(link)} onClick={load}>Load</button>
          </div>
          <div class="btns">
            <button class="btn ghost small" onClick={castIt}>Cast this design</button>
            <button class="btn ghost small" onClick={copy}>Copy link</button>
          </div>
          <p class="hint">Sharing makes a link to your colors, background, fonts and banner, without your words, friends, GIFs or song. Paste one here, or tap "Use this design" on a cast, to try it on.</p>
        </>, true)}
        {group('Background', <>
          {color('bg', 'Color', '#ffffff')}
          {image('bgImg', 'Image')}
          {select('bgMode', 'Image fit', BG_MODES, { tile: 'Tiled', cover: 'Fill the screen', center: 'Centered once' })}
          {range('bgDim', 'Darken', 0, 80, 0, '%')}
        </>)}
        {group('Colors and text', <>
          {color('text', 'Text', '#000000')}
          {color('muted', 'Quiet text', '#666666')}
          {color('link', 'Links and buttons', '#6447f5')}
          {select('font', 'Font', Object.keys(FONTS), FONT_NAMES)}
          {select('size', 'Text size', SIZES)}
        </>)}
        {group('Boxes', <>
          {color('box', 'Box color', '#ffffff')}
          {range('boxAlpha', 'Box opacity', 0, 100, 90, '%')}
          {color('border', 'Border color', '#e8e8ec')}
          {select('borderStyle', 'Border style', BORDERS)}
          {range('borderWidth', 'Border width', 0, 8, 1, 'px')}
          {range('radius', 'Corners', 0, 32, 14, 'px')}
        </>)}
        {group('Name and mood', <>
          {select('nameFx', 'Name effect', NAME_FX)}
          {color('nameColor', 'Effect color', '#ff3fa4')}
          {image('banner', 'Banner')}
          {text('moodEmoji', 'Mood emoji', 8, '😎')}
          {text('mood', 'Mood', LIMITS.mood, 'chillin')}
        </>)}
        {group('Profile song', <>
          <label class="field"><span>YouTube link</span>
            <input value={song} placeholder="https://youtu.be/…" onInput={(e) => {
              const v = e.currentTarget.value
              setSong(v)
              const id = ytId(v)
              if (id || !v.trim()) up({ song: id ? { id, start: ytStart(v) } : undefined })
            }} />
          </label>
          <p class="hint">{d.song ? d.song.title ? `Now: ${d.song.title}` : 'The song is checked when you save.' : 'Visitors press play to hear it. Add ?t=37 to start partway in.'}</p>
        </>)}
        {group('About me', <>
          {text('about', 'About me', LIMITS.about, '', true)}
          {text('meet', "Who I'd like to meet", LIMITS.meet, '', true)}
        </>)}
        {group('Interests', (Object.keys(INTERESTS) as (keyof typeof INTERESTS)[]).map((k) => (
          <label class="field"><span>{INTERESTS[k]}</span>
            <input value={d.interests?.[k] || ''} maxLength={LIMITS.interest} onInput={(e) => {
              const v = e.currentTarget.value
              set((x) => ({ ...x, interests: { ...x.interests, [k]: v || undefined } }))
            }} />
          </label>
        )))}
        {group(`Top friends (${d.top?.length || 0}/${LIMITS.top})`, <>
          {text('topTitle', 'Title', LIMITS.title, 'Top 8')}
          <div class="lk-chips">
            {(d.top || []).map((f, i) => {
              const u = users.get(f)
              return (
                <span class="lk-chip">
                  {u && <Avatar u={u} size={22} link={false} />}{u ? nameOf(u) : `fid ${f}`}
                  {i > 0 && <button aria-label="Move left" onClick={() => set((x) => ({ ...x, top: x.top!.map((y, j) => (j === i - 1 ? x.top![i] : j === i ? x.top![i - 1] : y)) }))}>‹</button>}
                  <button aria-label="Remove" onClick={() => set((x) => ({ ...x, top: x.top!.filter((y) => y !== f) }))}>×</button>
                </span>
              )
            })}
          </div>
          {(d.top?.length || 0) < LIMITS.top && (
            <>
              <label class="field"><span>Add someone</span><input value={q} placeholder="Search people" onInput={(e) => setQ(e.currentTarget.value)} /></label>
              {found.map((u) => (
                <button class="lk-found" onClick={() => (users.set(u.fid, u), set((x) => ({ ...x, top: [...new Set([...(x.top || []), u.fid])].slice(0, LIMITS.top) })), setQ(''))}>
                  <Avatar u={u} size={28} link={false} /><b>{nameOf(u)}</b><span class="muted">@{u.username}</span>
                </button>
              ))}
            </>
          )}
        </>)}
        {group(`GIF wall (${d.wall?.length || 0}/${LIMITS.wall})`, <>
          {text('wallTitle', 'Title', LIMITS.title, 'GIFs')}
          <div class="lk-wall edit">
            {(d.wall || []).map((u) => <span><Img src={u} /><button class="lk-x" aria-label="Remove" onClick={() => set((x) => ({ ...x, wall: x.wall!.filter((y) => y !== u) }))}>×</button></span>)}
          </div>
          {(d.wall?.length || 0) < LIMITS.wall && (
            <div class="btns">
              <button class="btn ghost small" onClick={() => setGif({ pick: addWall })}>Add a GIF</button>
              <button class="btn ghost small" onClick={() => upload(addWall)}>Upload</button>
            </div>
          )}
        </>)}
        <button class="btn danger small lk-reset" onClick={() => set(() => ({}))}>Start over (plain profile)</button>
        <p class="hint">Images can be up to 6 MB for the background and 4 MB for everything else. People can turn profile looks off in their Settings.</p>
      </div>
    </div>
  )
}

type Gif = { url: string; preview: string; title: string }
function GifPicker({ pick, close }: { pick: (url: string) => void; close: () => void }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<Gif[] | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      setList(null)
      fetch(`/api/gifs?q=${encodeURIComponent(q.trim() || 'sparkle')}`).then((r) => r.json()).then((l) => live && setList(Array.isArray(l) ? l : []), () => live && setList([]))
    }, 350)
    return () => ((live = false), clearTimeout(t))
  }, [q])
  return (
    <div class="lk-edit-body lk-gifs">
      <div class="lk-gifs-head">
        <input ref={input} value={q} placeholder="Search GIFs" onInput={(e) => setQ(e.currentTarget.value)} />
        <button class="btn ghost small" onClick={close}>Back</button>
      </div>
      {!list ? <div class="spinner" /> : !list.length ? <p class="hint">No GIFs found.</p> : (
        <div class="lk-gif-grid">{list.filter((g) => isLookImg(g.url)).map((g) => <button onClick={() => pick(g.url)} aria-label={g.title || 'GIF'}><Img src={g.preview} /></button>)}</div>
      )}
      <p class="hint">GIFs from Tenor.</p>
    </div>
  )
}
