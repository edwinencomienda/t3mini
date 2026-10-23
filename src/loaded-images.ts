// Chat images load lazily, so a long thread doesn't fetch every image at once. But a lazy image
// has no size until the browser's lazy loader gets to it, even one already loaded and cached:
// coming back to a thread, it starts 0 px tall and grows a frame or so later, and the restored
// scroll position slips while it does. So images already loaded in this tab load eagerly: the
// browser then sizes them from its memory cache at once, as the thread is drawn.

const loaded = new Set<string>()

/** Props for a chat `<img>`: lazy the first time, sized at once after that. */
export function imageLoading(src: string) {
  return {
    loading: loaded.has(src) ? ('eager' as const) : ('lazy' as const),
    onLoad: () => {
      if (loaded.size > 2000) loaded.clear()
      loaded.add(src)
    },
  }
}
