import { useEffect, useState } from 'react'
import { registerShared, shareSetting } from './shared-settings'

// Working background music (Settings → Appearance): a YouTube video or playlist plays, hidden,
// while any agent is working, and fades out when they're all done. Off by default; nothing
// from YouTube loads until it's on and needed.
//
// One song for everything: only one t3 mini tab plays (the one you used last, like the
// finish chime), however many agents are working.
//
// The player is a plain youtube-nocookie.com embed controlled with YouTube's postMessage
// commands; YouTube's JavaScript API is never loaded into t3 mini's own page.

export type MusicSettings = { enabled: boolean; url: string; volume: number }
const key = 't3-mini:background-music'
const defaults: MusicSettings = { enabled: false, url: '', volume: 40 }
const listeners = new Set<(settings: MusicSettings) => void>()

function load(): MusicSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}') as Partial<MusicSettings>
    return {
      enabled: saved.enabled === true,
      url: typeof saved.url === 'string' ? saved.url.slice(0, 500) : '',
      volume:
        typeof saved.volume === 'number' && saved.volume >= 0 && saved.volume <= 100
          ? Math.round(saved.volume)
          : defaults.volume,
    }
  } catch {
    return defaults
  }
}
// This browser's copy, and every component showing the settings.
function adopt(next: MusicSettings) {
  try {
    localStorage.setItem(key, JSON.stringify(next))
  } catch {
    // Storage can be unavailable; the choice still applies until reload.
  }
  listeners.forEach((listener) => listener(next))
}
// Saved for every browser and window too (see shared-settings.ts).
export function saveMusic(change: Partial<MusicSettings>) {
  const next = { ...load(), ...change }
  adopt(next)
  shareSetting({ music: next })
}
registerShared(
  'music',
  () => {
    if (typeof localStorage === 'undefined') return undefined
    const settings = load()
    return settings.enabled || settings.url ? settings : undefined
  },
  (music) => {
    const current = load()
    if (
      current.enabled !== music.enabled ||
      current.url !== music.url ||
      current.volume !== music.volume
    )
      adopt(music)
  },
)
export function useMusicSettings() {
  const [settings, setSettings] = useState(defaults)
  useEffect(() => {
    setSettings(load())
    listeners.add(setSettings)
    // Another tab changed them.
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) setSettings(load())
    }
    window.addEventListener('storage', onStorage)
    return () => {
      listeners.delete(setSettings)
      window.removeEventListener('storage', onStorage)
    }
  }, [])
  return settings
}

const videoId = /^[A-Za-z0-9_-]{11}$/
const listId = /^[A-Za-z0-9_-]{10,64}$/
// What to play from a YouTube link: a video (youtube.com/watch?v=, youtu.be/, /live/, /embed/,
// /shorts/, music.youtube.com) and/or a playlist (list=). Anything else isn't accepted.
export function parseYouTube(raw: string): { video?: string; list?: string } | undefined {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
  let video: string | undefined
  if (host === 'youtu.be') video = url.pathname.slice(1).split('/')[0]
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const [, kind, id] = url.pathname.split('/')
    video =
      url.searchParams.get('v') ??
      (['live', 'embed', 'shorts'].includes(kind ?? '') ? id : undefined) ??
      undefined
  } else return undefined
  const list = url.searchParams.get('list') ?? undefined
  const result = {
    ...(video && videoId.test(video) ? { video } : {}),
    ...(list && listId.test(list) ? { list } : {}),
  }
  return result.video || result.list ? result : undefined
}

// The embed address: no controls, starts paused, loops, and talks to this page only.
// Where the music was, per link, so a reload (or another tab) picks up from the same spot.
export type MusicPosition = { source: string; time: number; index?: number }
const positionKey = 't3-mini:background-music-position'
export const sourceKey = (source: { video?: string; list?: string }) =>
  `${source.video ?? ''}:${source.list ?? ''}`
export function loadPosition(source: string): { time: number; index?: number } | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(positionKey) || 'null') as MusicPosition | null
    if (!saved || saved.source !== source || !(saved.time >= 0)) return undefined
    return {
      time: saved.time,
      ...(Number.isInteger(saved.index) && saved.index! >= 0 ? { index: saved.index } : {}),
    }
  } catch {
    return undefined
  }
}
function keepPosition(position: MusicPosition) {
  try {
    localStorage.setItem(positionKey, JSON.stringify(position))
  } catch {
    // Without storage it just starts from the top next time.
  }
}
// Kept here and on the server (not broadcast; a window reads it when the music starts), so
// another browser or profile can pick up from the same spot.
export function savePosition(position: MusicPosition) {
  keepPosition(position)
  shareSetting({ musicPosition: position })
}
registerShared(
  'musicPosition',
  () => {
    if (typeof localStorage === 'undefined') return undefined
    try {
      return (JSON.parse(localStorage.getItem(positionKey) || 'null') as MusicPosition) ?? undefined
    } catch {
      return undefined
    }
  },
  (position) => keepPosition(position),
)

export function embedUrl(
  source: { video?: string; list?: string },
  origin: string,
  from?: { time: number; index?: number },
) {
  const params = new URLSearchParams({
    enablejsapi: '1',
    origin,
    controls: '0',
    playsinline: '1',
    loop: '1',
    rel: '0',
  })
  if (source.list) {
    params.set('list', source.list)
    params.set('listType', 'playlist')
  } else if (source.video) params.set('playlist', source.video) // loop a single video
  // Resume: the song in the playlist, and the second in the song.
  if (source.list && from?.index !== undefined) params.set('index', String(from.index))
  if (from && from.time >= 1) params.set('start', String(Math.floor(from.time)))
  return `https://www.youtube-nocookie.com/embed/${source.video ?? 'videoseries'}?${params}`
}
