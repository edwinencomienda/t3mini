import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadLibraries, pageDocument, pageTokens, previewTokens, themeCss } from './html-page'

const css = readFileSync(join(__dirname, 'styles.css'), 'utf8')
// A token's value in a CSS block of styles.css.
const tokenIn = (block: string, name: string) =>
  block.match(new RegExp(`\\s${name}:\\s*([^;]+);`))?.[1]?.trim()
const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
const darkStart = css.indexOf(":root[data-theme='dark'] {")
const darkBlock = css.slice(darkStart, css.indexOf('}', darkStart))

describe('previewTokens', () => {
  it('match styles.css, so the render check looks like the chat', () => {
    for (const name of pageTokens) {
      expect(previewTokens.light[name], `light ${name}`).toBe(tokenIn(lightBlock, name))
      expect(previewTokens.dark[name], `dark ${name}`).toBe(
        tokenIn(darkBlock, name) ?? tokenIn(lightBlock, name),
      )
    }
  })
})

describe('pageDocument', () => {
  it('puts our policy first and the agent’s HTML last, in <body>', () => {
    const page = pageDocument({
      html: '<meta http-equiv="Content-Security-Policy" content="default-src *"><p>x</p>',
      theme: themeCss(previewTokens.light, false),
      inline: true,
      still: false,
    })
    const policy = page.indexOf("default-src 'none'")
    expect(policy).toBeGreaterThan(0)
    expect(policy).toBeLessThan(page.indexOf('<body>'))
    expect(page.indexOf('default-src *')).toBeGreaterThan(page.indexOf('<body>'))
    expect(page).toContain(':where(table)')
    expect(page).toContain('--chart-1:#2563eb')
  })
  it('inlines Chart.js and its theme setup when asked', async () => {
    const libraries = await loadLibraries(['chart.js'])
    expect(libraries[0]!.source).toContain('Chart.js v4')
    // Inlined in a <script>: its source must never close the tag early.
    expect(libraries[0]!.source).not.toMatch(/<\/script/i)
    const page = pageDocument({ html: '', theme: '', inline: false, still: true, libraries })
    expect(page).toContain('window.t3={color:color,palette:palette}')
    expect(page.indexOf('Chart.js v4')).toBeLessThan(page.indexOf('<body>'))
  })
})
