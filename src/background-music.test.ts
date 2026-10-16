import { expect, it } from 'vitest'
import { embedUrl, parseYouTube } from './background-music'

it('reads YouTube video and playlist links', () => {
  expect(parseYouTube('https://www.youtube.com/watch?v=jfKfPfyJRdk')).toEqual({
    video: 'jfKfPfyJRdk',
  })
  expect(parseYouTube('https://youtu.be/jfKfPfyJRdk?si=abc')).toEqual({ video: 'jfKfPfyJRdk' })
  expect(parseYouTube('https://www.youtube.com/live/jfKfPfyJRdk')).toEqual({ video: 'jfKfPfyJRdk' })
  expect(
    parseYouTube(
      'https://music.youtube.com/watch?v=jfKfPfyJRdk&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
    ),
  ).toEqual({
    video: 'jfKfPfyJRdk',
    list: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
  })
  expect(
    parseYouTube('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'),
  ).toEqual({
    list: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG',
  })
})

it('refuses anything that isn’t a YouTube link', () => {
  for (const link of [
    '',
    'lofi',
    'https://example.com/watch?v=jfKfPfyJRdk',
    'https://youtube.com.evil.com/watch?v=jfKfPfyJRdk',
    'javascript:alert(1)',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=jfKfPfyJRdk"><script>',
    'https://www.youtube.com/channel/UC123',
  ])
    expect(parseYouTube(link), link).toBeUndefined()
})

it('builds a looping, controls-free embed on youtube-nocookie.com', () => {
  const single = new URL(embedUrl({ video: 'jfKfPfyJRdk' }, 'http://127.0.0.1:4310'))
  expect(single.origin).toBe('https://www.youtube-nocookie.com')
  expect(single.pathname).toBe('/embed/jfKfPfyJRdk')
  expect(Object.fromEntries(single.searchParams)).toMatchObject({
    enablejsapi: '1',
    origin: 'http://127.0.0.1:4310',
    controls: '0',
    loop: '1',
    playlist: 'jfKfPfyJRdk',
  })
  const list = new URL(embedUrl({ list: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG' }, 'http://x'))
  expect(list.pathname).toBe('/embed/videoseries')
  expect(list.searchParams.get('list')).toBe('PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG')
})

it('resumes from a saved spot: the second in the song, and the song in a playlist', () => {
  const single = new URL(embedUrl({ video: 'jfKfPfyJRdk' }, 'http://x', { time: 125.7 }))
  expect(single.searchParams.get('start')).toBe('125')
  expect(single.searchParams.get('index')).toBeNull()
  const list = new URL(
    embedUrl({ list: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG' }, 'http://x', { time: 30, index: 4 }),
  )
  expect(list.searchParams.get('index')).toBe('4')
  expect(list.searchParams.get('start')).toBe('30')
  // Under a second in, there's nothing to skip.
  expect(
    new URL(embedUrl({ video: 'jfKfPfyJRdk' }, 'http://x', { time: 0.4 })).searchParams.has(
      'start',
    ),
  ).toBe(false)
})
