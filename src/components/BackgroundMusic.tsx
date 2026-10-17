import { useEffect, useRef, useState } from 'react'
import {
  embedUrl,
  loadPosition,
  parseYouTube,
  savePosition,
  sourceKey as keyOf,
  useMusicSettings,
} from '../background-music'
import { isNotifyingTab } from '../notifications'
import { fetchShared } from '../shared-settings'

// The hidden music player (see music.ts). It plays while `working` (any agent is working) in
// the one tab that plays sounds, fading in and out; elsewhere it stays paused. The embed is
// only created the first time music is needed, and removed when the setting is turned off.

const origin = 'https://www.youtube-nocookie.com'
const fadeMs = 1500

export function BackgroundMusic({
  working,
  onPlayingChange,
}: {
  working: boolean
  // Music started or stopped in this tab (for the radio character in the chat header).
  onPlayingChange?: (playing: boolean) => void
}) {
  const settings = useMusicSettings()
  const source = settings.enabled ? parseYouTube(settings.url) : undefined
  const frame = useRef<HTMLIFrameElement>(null)
  const [needed, setNeeded] = useState(false)
  const [ready, setReady] = useState(false)
  const playing = useRef(false)
  const level = useRef(0)
  const fade = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const command = (func: string, args: unknown[] = []) =>
    frame.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args }),
      origin,
    )
  function fadeTo(target: number, then?: () => void) {
    clearInterval(fade.current)
    const step = (target - level.current) / (fadeMs / 100)
    fade.current = setInterval(() => {
      // Step toward the target without going past it.
      const next = level.current + step
      const done = step === 0 || (step > 0 ? next >= target : next <= target)
      level.current = done ? target : next
      command('setVolume', [Math.round(level.current)])
      if (done) {
        clearInterval(fade.current)
        then?.()
      }
    }, 100)
  }

  const sourceKey = source ? keyOf(source) : ''
  // What the player last reported (time, playlist position; duration 0 means a live stream),
  // saved so a reload or another tab resumes from the same spot.
  const info = useRef<{ time?: number; index?: number; duration?: number }>({})
  const remember = () => {
    const { time, index, duration } = info.current
    if (!sourceKey || time === undefined || !duration) return
    savePosition({ source: sourceKey, time, ...(index !== undefined ? { index } : {}) })
  }
  // Where to start: the saved spot, read when the player is created.
  const [from, setFrom] = useState<{ time: number; index?: number } | undefined>()
  const starting = useRef(false)
  useEffect(() => {
    // The player's own reports, from the embed only.
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return
      try {
        const data = JSON.parse(String(event.data)) as {
          event?: string
          info?: { currentTime?: unknown; playlistIndex?: unknown; duration?: unknown }
        }
        if (data.event !== 'infoDelivery' || !data.info) return
        const { currentTime, playlistIndex, duration } = data.info
        if (typeof currentTime === 'number') info.current.time = currentTime
        if (typeof playlistIndex === 'number') info.current.index = playlistIndex
        if (typeof duration === 'number') info.current.duration = duration
      } catch {
        // Not a player report.
      }
    }
    window.addEventListener('message', onMessage)
    const save = setInterval(() => {
      if (playing.current) remember()
    }, 5000)
    window.addEventListener('pagehide', remember)
    return () => {
      window.removeEventListener('message', onMessage)
      clearInterval(save)
      window.removeEventListener('pagehide', remember)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey])
  useEffect(() => {
    // A new song or the setting turned off: start over.
    playing.current = false
    onPlayingChange?.(false)
    level.current = 0
    setReady(false)
    if (!sourceKey) setNeeded(false)
  }, [sourceKey])

  useEffect(() => {
    if (!source) return
    const check = () => {
      const shouldPlay = working && isNotifyingTab()
      if (shouldPlay && !needed && !starting.current) {
        // Start from the latest spot: the server's (maybe from another browser) when it's for
        // this song, else this browser's. Don't wait more than a moment for it.
        starting.current = true
        const local = loadPosition(sourceKey)
        void Promise.race([
          fetchShared(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
        ]).then((shared) => {
          const position = shared?.musicPosition
          setFrom(
            position?.source === sourceKey
              ? {
                  time: position.time,
                  ...(position.index !== undefined ? { index: position.index } : {}),
                }
              : local,
          )
          setNeeded(true)
          starting.current = false
        })
      }
      if (!ready) return
      if (shouldPlay && !playing.current) {
        playing.current = true
        onPlayingChange?.(true)
        command('setVolume', [Math.round(level.current)])
        command('playVideo')
        fadeTo(settings.volume)
      } else if (!shouldPlay && playing.current) {
        playing.current = false
        onPlayingChange?.(false)
        fadeTo(0, () => {
          command('pauseVideo')
          remember()
        })
      } else if (shouldPlay && playing.current && Math.round(level.current) !== settings.volume)
        fadeTo(settings.volume)
    }
    check()
    // Switching tabs hands the music over: the old tab notices on the next check (or right
    // away through the storage event) and fades out.
    const timer = setInterval(check, 2000)
    const onStorage = () => check()
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', onStorage)
    return () => {
      clearInterval(timer)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', onStorage)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, ready, needed, sourceKey, settings.volume])

  useEffect(() => () => clearInterval(fade.current), [])

  if (!source || !needed) return null
  return (
    <iframe
      ref={frame}
      className="music-player"
      title="Working background music"
      src={embedUrl(source, window.location.origin, from)}
      allow="autoplay; encrypted-media"
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="strict-origin-when-cross-origin"
      aria-hidden
      tabIndex={-1}
      onLoad={() => {
        // Ask the player to report its position (YouTube's embed protocol).
        frame.current?.contentWindow?.postMessage(
          JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }),
          origin,
        )
        setTimeout(() => setReady(true), 500)
      }}
    />
  )
}
