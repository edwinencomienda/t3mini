import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Download, Maximize2, Minus, Plus, Workflow, X } from 'lucide-react'
import { diagramKind } from '../diagrams'
import { CopyButton } from './CopyButton'
import { Modal } from './Modal'

// Mermaid diagrams in replies: from the show_diagram tool, and ```mermaid code blocks.
//
// The source comes from the agent, so it's treated as untrusted: Mermaid runs with
// securityLevel 'strict' (no HTML labels, scripts, or click handlers), and its SVG goes
// through DOMPurify before it's put in the page. Mermaid (~1 MB) loads only when a diagram
// first appears, and drawings are cached per source and theme.

type Mermaid = (typeof import('mermaid'))['default']
type Purify = (typeof import('dompurify'))['default']
let libraries: Promise<{ mermaid: Mermaid; purify: Purify }> | undefined
const load = () =>
  (libraries ??= Promise.all([import('mermaid'), import('dompurify')]).then(([mermaid, purify]) => {
    // Links may only point inside the diagram (markers, gradients): nothing loads or opens.
    purify.default.addHook('uponSanitizeAttribute', (_node, data) => {
      if (
        (data.attrName === 'href' || data.attrName === 'xlink:href') &&
        !data.attrValue.startsWith('#')
      )
        data.keepAttr = false
    })
    return { mermaid: mermaid.default, purify: purify.default }
  }))

// Colors follow the app's palette (styles.css), so diagrams sit quietly in the chat.
const palettes = {
  light: {
    background: '#ffffff',
    node: '#f4f4f5',
    nodeBorder: '#d4d4d8',
    text: '#27272a',
    muted: '#71717a',
    line: '#a1a1aa',
    cluster: '#fafafa',
    clusterBorder: '#e4e4e7',
    accent: '#eef2ff',
    accentBorder: '#c7d2fe',
    note: '#fffbeb',
    noteBorder: '#fcd34d',
  },
  // The diagram sits on a card (--card, #1c1c1c in dark): boxes a step lighter, labels on the
  // card's own color.
  dark: {
    background: '#1c1c1c',
    node: '#252528',
    nodeBorder: '#45454c',
    text: '#f4f4f5',
    muted: '#a1a1aa',
    line: '#7a7a82',
    cluster: '#212123',
    clusterBorder: '#38383d',
    accent: '#1e1b4b',
    accentBorder: '#4338ca',
    note: '#292211',
    noteBorder: '#a16207',
  },
}
// Pie slices, chart series, git branches…: a calm set that reads in both themes.
const series = [
  '#6366f1',
  '#14b8a6',
  '#f59e0b',
  '#ec4899',
  '#0ea5e9',
  '#84cc16',
  '#a855f7',
  '#f97316',
  '#10b981',
  '#ef4444',
  '#64748b',
  '#eab308',
]
const fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"

function config(dark: boolean) {
  const c = dark ? palettes.dark : palettes.light
  const numbered = (prefix: string, from = 0) =>
    Object.fromEntries(series.map((color, index) => [`${prefix}${index + from}`, color]))
  return {
    startOnLoad: false,
    securityLevel: 'strict' as const,
    theme: 'base' as const,
    fontFamily,
    maxTextSize: 50_000,
    flowchart: { padding: 14 },
    sequence: { mirrorActors: false, actorMargin: 60, boxMargin: 8 },
    gantt: {
      fontSize: 12,
      sectionFontSize: 12,
      barHeight: 24,
      barGap: 6,
      topPadding: 44,
      leftPadding: 80,
      gridLineStartPadding: 36,
      // A default only: a diagram's own axisFormat wins.
      axisFormat: '%b %d',
    },
    themeVariables: {
      darkMode: dark,
      fontFamily,
      fontSize: '14px',
      background: c.background,
      primaryColor: c.node,
      primaryBorderColor: c.nodeBorder,
      primaryTextColor: c.text,
      secondaryColor: c.accent,
      secondaryBorderColor: c.accentBorder,
      secondaryTextColor: c.text,
      tertiaryColor: c.cluster,
      tertiaryBorderColor: c.clusterBorder,
      tertiaryTextColor: c.text,
      mainBkg: c.node,
      nodeBorder: c.nodeBorder,
      nodeTextColor: c.text,
      textColor: c.text,
      titleColor: c.text,
      lineColor: c.line,
      defaultLinkColor: c.line,
      edgeLabelBackground: c.background,
      clusterBkg: c.cluster,
      clusterBorder: c.clusterBorder,
      noteBkgColor: c.note,
      noteBorderColor: c.noteBorder,
      noteTextColor: c.text,
      // Sequence diagrams
      actorBkg: c.node,
      actorBorder: c.nodeBorder,
      actorTextColor: c.text,
      actorLineColor: c.clusterBorder,
      signalColor: c.muted,
      signalTextColor: c.text,
      labelBoxBkgColor: c.node,
      labelBoxBorderColor: c.nodeBorder,
      labelTextColor: c.text,
      loopTextColor: c.muted,
      activationBkgColor: c.accent,
      activationBorderColor: c.accentBorder,
      sequenceNumberColor: dark ? '#111111' : '#ffffff',
      // State and class diagrams, ER
      altBackground: c.cluster,
      attributeBackgroundColorOdd: c.background,
      attributeBackgroundColorEven: c.cluster,
      // Gantt
      sectionBkgColor: c.cluster,
      altSectionBkgColor: c.background,
      sectionBkgColor2: c.cluster,
      taskBkgColor: series[0],
      taskBorderColor: series[0],
      taskTextColor: '#ffffff',
      taskTextOutsideColor: c.text,
      activeTaskBkgColor: c.accent,
      activeTaskBorderColor: series[0],
      doneTaskBkgColor: c.nodeBorder,
      doneTaskBorderColor: c.nodeBorder,
      critBkgColor: '#ef4444',
      critBorderColor: '#ef4444',
      gridColor: c.clusterBorder,
      todayLineColor: '#ef4444',
      // Pie, git graph, mind map / timeline sections
      ...numbered('pie', 1),
      pieOpacity: '1',
      pieStrokeColor: c.background,
      pieOuterStrokeColor: c.clusterBorder,
      pieSectionTextColor: '#ffffff',
      pieTitleTextColor: c.text,
      pieLegendTextColor: c.text,
      ...numbered('git'),
      ...numbered('cScale'),
      ...Object.fromEntries(series.map((_, index) => [`cScaleLabel${index}`, '#ffffff'])),
      commitLabelColor: c.text,
      commitLabelBackground: c.node,
    },
  }
}

// Draws one diagram at a time: Mermaid's config is global, so renders mustn't interleave.
let queue: Promise<unknown> = Promise.resolve()
let counter = 0
const cache = new Map<string, string>()
function draw(source: string, dark: boolean): Promise<string> {
  const key = `${dark ? 'dark' : 'light'}\n${source}`
  const cached = cache.get(key)
  if (cached) return Promise.resolve(cached)
  const job = queue.then(async () => {
    const { mermaid, purify } = await load()
    mermaid.initialize(config(dark))
    const id = `t3-diagram-${++counter}`
    try {
      await mermaid.parse(source)
      const { svg } = await mermaid.render(id, source)
      // Mermaid's labels are HTML inside <foreignObject> (already cleaned by Mermaid in strict
      // mode); the whole SVG is cleaned again here, keeping only inert SVG, HTML text, MathML (KaTeX labels), and
      // Mermaid's own <style> block (its theme).
      const clean = purify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true, html: true, mathMl: true },
        ADD_TAGS: ['foreignObject', 'style'],
        HTML_INTEGRATION_POINTS: { foreignobject: true },
        // <a> stays (Mermaid wraps `click` nodes in it) but loses its URL in the hook above.
        FORBID_TAGS: ['img', 'image', 'iframe', 'form', 'input', 'button'],
        FORBID_ATTR: ['src', 'action', 'formaction'],
      })
      if (cache.size > 100) cache.delete(cache.keys().next().value!)
      cache.set(key, clean)
      return clean
    } finally {
      // Mermaid can leave its scratch element behind when a diagram fails.
      document.getElementById(id)?.remove()
      document.getElementById(`d${id}`)?.remove()
    }
  })
  queue = job.catch(() => {})
  return job
}
// Mermaid's error messages lead with the useful part; keep them short.
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).split('\n').slice(0, 4).join('\n')

// Whether the page is in dark mode right now (the theme toggle or the OS setting).
const isDark = () =>
  typeof document !== 'undefined' &&
  getComputedStyle(document.documentElement).colorScheme === 'dark'
function useDark() {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const read = () => setDark(isDark())
    const media = matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', read)
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    // The theme may have changed between the first render and now (e.g. the saved theme
    // applied as the page loads): read it again so that change isn't missed.
    read()
    return () => {
      media.removeEventListener('change', read)
      observer.disconnect()
    }
  }, [])
  return dark
}

type State =
  { status: 'drawing' } | { status: 'ready'; svg: string } | { status: 'error'; message: string }
function useDiagram(source: string): State {
  const dark = useDark()
  const [state, setState] = useState<State>({ status: 'drawing' })
  useEffect(() => {
    let cancelled = false
    // A short pause so a streaming ```mermaid block isn't redrawn on every chunk.
    const timer = setTimeout(() => {
      draw(source, dark).then(
        (svg) => !cancelled && setState({ status: 'ready', svg }),
        (error: unknown) => !cancelled && setState({ status: 'error', message: errorText(error) }),
      )
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [source, dark])
  return state
}

function download(svg: string, name: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${name.replace(/[^\w -]+/g, '').trim() || 'diagram'}.svg`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// The full-screen view: the diagram fitted to the window, with zoom and download.
function DiagramPreview({
  svg,
  title,
  onClose,
}: {
  svg: string
  title: string
  onClose: () => void
}) {
  const [zoom, setZoom] = useState(1)
  const step = (factor: number) => setZoom((value) => Math.min(4, Math.max(0.25, value * factor)))
  return (
    <Modal className="diagram-preview" label={title} onClose={onClose}>
      <div className="diagram-preview-bar">
        <span className="diagram-title">
          <Workflow size={14} />
          {title}
        </span>
        <div className="diagram-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom out"
            onClick={() => step(1 / 1.25)}
          >
            <Minus size={14} />
          </button>
          <button
            type="button"
            className="diagram-zoom"
            title="Fit to window"
            onClick={() => setZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom in"
            onClick={() => step(1.25)}
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Download SVG"
            title="Download SVG"
            onClick={() => download(svg, title)}
          >
            <Download size={14} />
          </button>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="diagram-preview-stage">
        <div
          className="diagram-svg"
          style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
          // Sanitized by DOMPurify in draw().
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </Modal>
  )
}

export const Diagram = memo(function Diagram({
  source,
  title,
  fallback,
}: {
  source: string
  title?: string
  // Shown instead of the card while the source doesn't draw (a ```mermaid block that's still
  // streaming, or isn't valid): the plain code block.
  fallback?: ReactNode
}) {
  const state = useDiagram(source)
  const [view, setView] = useState<'diagram' | 'code'>('diagram')
  const [expanded, setExpanded] = useState(false)
  const name = title || diagramKind(source) || 'Diagram'
  // Wide diagrams shrink to fit, but not below 65% (text stays readable); past that the card
  // scrolls sideways.
  const canvas = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const svg = canvas.current?.querySelector('svg')
    const width = svg?.viewBox.baseVal?.width
    if (svg && width) svg.style.minWidth = `${Math.round(width * 0.65)}px`
  })
  if (fallback && state.status !== 'ready') return fallback
  return (
    <figure className="diagram">
      <div className="diagram-bar">
        <span className="diagram-title">
          <Workflow size={13} />
          {name}
        </span>
        <div className="diagram-actions">
          <div className="segmented" role="group" aria-label="View">
            {(['diagram', 'code'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="segmented-option"
                aria-pressed={view === option}
                data-checked={view === option ? '' : undefined}
                onClick={() => setView(option)}
              >
                {option === 'diagram' ? 'Diagram' : 'Code'}
              </button>
            ))}
          </div>
          <CopyButton className="diagram-copy" label="Copy Mermaid source" text={() => source} />
          <button
            type="button"
            className="icon-button"
            aria-label="Expand diagram"
            title="Expand"
            disabled={state.status !== 'ready'}
            onClick={() => setExpanded(true)}
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
      {view === 'code' ? (
        <pre className="diagram-code">
          <code>{source}</code>
        </pre>
      ) : state.status === 'ready' ? (
        <div
          ref={canvas}
          className="diagram-canvas"
          role="button"
          tabIndex={0}
          aria-label={`${name}, open full screen`}
          onClick={() => setExpanded(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setExpanded(true)
            }
          }}
        >
          <div
            className="diagram-svg"
            // Sanitized by DOMPurify in draw().
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        </div>
      ) : state.status === 'error' ? (
        <div className="diagram-error">
          <AlertTriangle size={14} />
          <div>
            <strong>This diagram couldn’t be drawn.</strong>
            <pre>{state.message}</pre>
          </div>
        </div>
      ) : (
        <div className="diagram-drawing" aria-busy="true">
          Drawing diagram…
        </div>
      )}
      {expanded && state.status === 'ready' ? (
        <DiagramPreview svg={state.svg} title={name} onClose={() => setExpanded(false)} />
      ) : null}
    </figure>
  )
})
