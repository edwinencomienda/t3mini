// The page an agent's HTML (show_html) runs in, built the same way in the chat (HtmlView.tsx)
// and on the server for the render check the agent gets back (tools/show-html.ts): our
// Content-Security-Policy first, the app's theme as CSS variables, a quiet base stylesheet,
// the height reporter, and any bundled library the page asked for. The agent's HTML goes last,
// inside <body>, so it can't loosen the policy (a CSP <meta> in <body> is ignored).

// No network at all: only inline code and data:/blob: URLs.
export const pagePolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

// The app's design tokens a page gets as CSS variables (read from styles.css in the chat).
export const pageTokens = [
  '--background',
  '--foreground',
  '--card',
  '--muted',
  '--muted-foreground',
  '--faint',
  '--accent',
  '--border',
  '--input',
  '--primary',
  '--primary-foreground',
  '--success',
  '--warning',
  '--danger',
  '--code-surface',
  '--radius',
  '--font-sans',
  '--font-mono',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--chart-6',
] as const

const fontSans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
const fontMono = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
// The same tokens for the server's render check, which has no styles.css to read. Copied from
// styles.css (html-page.test.ts keeps them in step).
export const previewTokens: Record<
  'light' | 'dark',
  Record<(typeof pageTokens)[number], string>
> = {
  light: {
    '--background': '#fbfbfc',
    '--foreground': '#27272a',
    '--card': '#ffffff',
    '--muted': '#f4f4f5',
    '--muted-foreground': '#71717a',
    '--faint': '#a1a1aa',
    '--accent': '#f0f0f2',
    '--border': '#e4e4e7',
    '--input': '#d4d4d8',
    '--primary': 'oklch(0.488 0.217 264)',
    '--primary-foreground': '#ffffff',
    '--success': '#16a34a',
    '--warning': '#d97706',
    '--danger': '#dc2626',
    '--code-surface': '#f4f4f5',
    '--radius': '0.5rem',
    '--font-sans': fontSans,
    '--font-mono': fontMono,
    '--chart-1': '#2563eb',
    '--chart-2': '#0d9488',
    '--chart-3': '#d97706',
    '--chart-4': '#db2777',
    '--chart-5': '#7c3aed',
    '--chart-6': '#65a30d',
  },
  dark: {
    '--background': '#131313',
    '--foreground': '#f5f5f5',
    '--card': '#1c1c1c',
    '--muted': 'rgb(255 255 255 / 3%)',
    '--muted-foreground': '#8e8e8e',
    '--faint': '#5c5c5c',
    '--accent': 'rgb(255 255 255 / 5%)',
    '--border': 'rgb(255 255 255 / 7%)',
    '--input': 'rgb(255 255 255 / 10%)',
    '--primary': 'oklch(0.571 0.21 264)',
    '--primary-foreground': '#ffffff',
    '--success': '#4ade80',
    '--warning': '#fbbf24',
    '--danger': '#f87171',
    '--code-surface': 'rgb(255 255 255 / 4%)',
    '--radius': '0.5rem',
    '--font-sans': fontSans,
    '--font-mono': fontMono,
    '--chart-1': '#60a5fa',
    '--chart-2': '#2dd4bf',
    '--chart-3': '#fbbf24',
    '--chart-4': '#f472b6',
    '--chart-5': '#a78bfa',
    '--chart-6': '#a3e635',
  },
}

// The theme as page CSS: the tokens, the color scheme, and the chat's own text style.
export function themeCss(values: Record<string, string>, dark: boolean) {
  const vars = pageTokens.map((name) => `${name}:${values[name] ?? ''}`).join(';')
  return `:root{${vars};color-scheme:${dark ? 'dark' : 'light'}}html,body{margin:0;background:transparent;color:var(--foreground);font:14px/1.5 var(--font-sans)}body{padding:2px}`
}

// Plain HTML looks like t3 mini without any CSS: headings, tables, buttons, inputs, code. All
// inside :where(), so it has no specificity and any rule the page sets wins.
export const baseCss = [
  ':where(*,*::before,*::after){box-sizing:border-box}',
  ':where(h1,h2,h3,h4){margin:0 0 .5em;line-height:1.25;font-weight:600}',
  ':where(h1){font-size:20px}:where(h2){font-size:17px}:where(h3){font-size:15px}:where(h4){font-size:14px}',
  ':where(p,ul,ol){margin:0 0 .75em}:where(ul,ol){padding-left:1.25em}',
  ':where(small,.muted){color:var(--muted-foreground)}',
  ':where(a){color:var(--primary);text-decoration:none}:where(a:hover){text-decoration:underline}',
  ':where(code,kbd,pre,samp){font-family:var(--font-mono);font-size:.9em}',
  ':where(code){background:var(--code-surface);padding:.1em .35em;border-radius:4px}',
  ':where(pre){margin:0 0 .75em;background:var(--code-surface);padding:.75em 1em;border-radius:var(--radius);overflow:auto}',
  ':where(pre code){background:none;padding:0}',
  ':where(kbd){border:1px solid var(--border);border-bottom-width:2px;border-radius:4px;padding:0 .35em}',
  ':where(table){width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}',
  ':where(th,td){padding:.5em .75em;text-align:left;border-bottom:1px solid var(--border)}',
  ':where(th){font-size:12px;font-weight:600;color:var(--muted-foreground)}',
  ':where(tbody tr:hover){background:var(--accent)}',
  ':where(button){font:inherit;color:var(--foreground);background:var(--card);border:1px solid var(--input);border-radius:var(--radius);padding:.35em .8em;cursor:pointer}',
  ':where(button:hover){background:var(--accent)}',
  ':where(button.primary){background:var(--primary);color:var(--primary-foreground);border-color:transparent}',
  ':where(button.primary:hover){filter:brightness(1.08)}',
  ':where(button:disabled){opacity:.5;cursor:default}',
  ':where(input,select,textarea){font:inherit;color:var(--foreground);background:var(--background);border:1px solid var(--input);border-radius:var(--radius);padding:.35em .6em}',
  ':where(input[type=range],input[type=checkbox],input[type=radio]){accent-color:var(--primary);padding:0}',
  ':where(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--primary);outline-offset:1px}',
  ':where(hr){border:0;border-top:1px solid var(--border);margin:1em 0}',
  ':where(img,svg,canvas,video){max-width:100%}',
].join('')

// Reports the page's height to the card (only a number goes out).
export const sizerScript = `(function(){var last=0;function post(){var h=Math.ceil(document.documentElement.scrollHeight);if(h!==last){last=h;parent.postMessage({t3html:'size',h:h},'*')}}addEventListener('load',post);new ResizeObserver(post).observe(document.documentElement);setTimeout(post,50)})()`

// Shown again (back in a thread you've seen), a page opens finished: for its first 3 seconds CSS
// animations and transitions take no time, requestAnimationFrame runs as if they'd long since
// ended, and Chart.js doesn't animate (window.t3Still, read by chartSetup), so a chart doesn't
// draw itself again on every visit; after that it behaves normally. The render check uses it
// too, so its screenshot shows the finished page.
export const settledHead = `<style id="t3-settled">*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}</style><script>(function(){window.t3Still=true;var raf=requestAnimationFrame.bind(window),until=performance.now()+3000;window.requestAnimationFrame=function(cb){return raf(function(t){cb(performance.now()<until?t+1e7:t)})};setTimeout(function(){window.t3Still=false;var s=document.getElementById('t3-settled');if(s)s.remove()},3000)})()</script>`

// Libraries a page may ask for, bundled with t3 mini and inlined (no network).
export const pageLibraries = ['chart.js'] as const
export type PageLibrary = (typeof pageLibraries)[number]

// After Chart.js: its defaults follow the theme (text, grid, tooltip, font), datasets without
// colors get the chart palette, and window.t3 has helpers: t3.color('--chart-1') (any CSS color
// or token as rgba(), which canvas needs; oklch and var() don't work there) and t3.palette.
export const chartSetup = `(function(){if(!window.Chart)return;var cs=getComputedStyle(document.documentElement);var cv=document.createElement('canvas');cv.width=cv.height=1;var x=cv.getContext('2d',{willReadFrequently:true});function color(v,a){v=String(v||'').trim();if(v.indexOf('--')===0)v=cs.getPropertyValue(v).trim();x.clearRect(0,0,1,1);x.fillStyle='#000';x.fillStyle=v;x.fillRect(0,0,1,1);var d=x.getImageData(0,0,1,1).data;return 'rgba('+d[0]+','+d[1]+','+d[2]+','+(a==null?+(d[3]/255).toFixed(3):a)+')'}var palette=[1,2,3,4,5,6].map(function(i){return color('--chart-'+i)});window.t3={color:color,palette:palette};var D=Chart.defaults;D.color=color('--muted-foreground');D.borderColor=color('--border');D.font.family=cs.getPropertyValue('--font-sans').trim();D.font.size=12;D.plugins.legend.labels.usePointStyle=true;D.plugins.legend.labels.boxWidth=8;D.plugins.legend.labels.boxHeight=8;var tip=D.plugins.tooltip;tip.backgroundColor=color('--card');tip.titleColor=color('--foreground');tip.bodyColor=color('--foreground');tip.borderColor=color('--border');tip.borderWidth=1;tip.padding=8;tip.cornerRadius=6;tip.boxPadding=4;tip.usePointStyle=true;D.elements.line.borderWidth=2;D.elements.line.tension=0.3;D.elements.point.radius=0;D.elements.point.hoverRadius=4;D.elements.point.hitRadius=8;D.elements.bar.borderRadius=4;D.elements.arc.borderWidth=2;D.interaction.mode='index';D.interaction.intersect=false;if(window.t3Still){var anim=D.animation;D.animation=false;setTimeout(function(){D.animation=anim},3000)}var round=['pie','doughnut','polarArea'];Chart.register({id:'t3Palette',beforeUpdate:function(chart){var type=chart.config.type;(chart.data.datasets||[]).forEach(function(ds,i){var kind=ds.type||type;var c=palette[i%palette.length];if(round.indexOf(kind)>=0){if(!ds.backgroundColor)ds.backgroundColor=(chart.data.labels||[]).map(function(_,j){return palette[j%palette.length]});if(!ds.borderColor)ds.borderColor=color('--background')}else{if(!ds.borderColor)ds.borderColor=c;if(!ds.backgroundColor)ds.backgroundColor=kind==='line'||kind==='radar'?color(c,0.12):c;if(!ds.pointBackgroundColor)ds.pointBackgroundColor=c}})}})})()`

export function pageDocument({
  html,
  theme,
  inline,
  still,
  libraries = [],
}: {
  html: string
  // themeCss() output.
  theme: string
  // In the reply: no scrolling inside, and no outer margin or padding whatever the page sets.
  inline: boolean
  still: boolean
  // The library sources to inline (Chart.js…), already loaded.
  libraries?: { name: PageLibrary; source: string }[]
}) {
  const scripts = libraries
    .map(
      (library) =>
        `<script>${library.source}</script>${library.name === 'chart.js' ? `<script>${chartSetup}</script>` : ''}`,
    )
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${pagePolicy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}${baseCss}${inline ? 'html,body{overflow:hidden}body{margin:0!important;padding:0!important}' : ''}</style><script>${sizerScript}</script>${still ? settledHead : ''}${scripts}</head><body>${html}</body></html>`
}

// A bundled library's source, loaded on first use (a separate chunk; it's ~200 KB).
const sources = new Map<PageLibrary, Promise<string>>()
export function librarySource(name: PageLibrary) {
  let source = sources.get(name)
  if (!source) {
    source = import('../node_modules/chart.js/dist/chart.umd.min.js?raw').then(
      (module) => module.default as string,
    )
    source.catch(() => sources.delete(name))
    sources.set(name, source)
  }
  return source
}
export const loadLibraries = (names: readonly PageLibrary[] = []) =>
  Promise.all(names.map(async (name) => ({ name, source: await librarySource(name) })))
