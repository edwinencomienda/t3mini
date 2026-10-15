import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { serveGateway, servesGateway, stopServingGateway, tailscaleStatus } from './tailscale'

// A stand-in `tailscale` CLI: logs its arguments, then prints canned output per subcommand.
let directory: string
let log: string
const defaultBin = process.env.TAILSCALE_BIN
async function fakeCli(script: string) {
  directory = await mkdtemp(join(tmpdir(), 't3-mini-tailscale-'))
  log = join(directory, 'calls.log')
  const bin = join(directory, 'tailscale')
  await writeFile(bin, `#!/bin/sh\necho "$@" >> "${log}"\n${script}\n`)
  await chmod(bin, 0o755)
  process.env.TAILSCALE_BIN = bin
}
const calls = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n')
beforeEach(() => {
  delete process.env.T3_MINI_TAILSCALE_PORT
})
afterEach(async () => {
  process.env.TAILSCALE_BIN = defaultBin
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('reads the tailnet name when Tailscale is connected', async () => {
  await fakeCli(`echo '{"BackendState":"Running","Self":{"DNSName":"mac.tail1234.ts.net."}}'`)
  expect(await tailscaleStatus()).toEqual({
    available: true,
    running: true,
    dnsName: 'mac.tail1234.ts.net',
  })
  expect(await calls()).toEqual(['status --json'])
})

it('explains why Tailscale can’t be used', async () => {
  // Stopped: the CLI exits non-zero but still prints its JSON.
  await fakeCli(`echo '{"BackendState":"Stopped","Self":{"DNSName":""}}'; exit 1`)
  expect(await tailscaleStatus()).toMatchObject({ running: false, problem: /sign in/ })
  await fakeCli(`echo '{"BackendState":"Running","Self":{"DNSName":""}}'`)
  expect(await tailscaleStatus()).toMatchObject({ running: false, problem: /MagicDNS/ })
  process.env.TAILSCALE_BIN = join(directory, 'missing')
  expect(await tailscaleStatus()).toMatchObject({ available: false, running: false })
})

it('serves the gateway over HTTPS on the tailnet only (never Funnel)', async () => {
  await fakeCli('exit 0')
  await serveGateway(4311)
  expect(await calls()).toEqual(['serve --bg --https=8443 http://127.0.0.1:4311'])
  expect((await calls()).join(' ')).not.toMatch(/funnel/)
})

it('stops the whole serve process when it waits for approval, even behind a wrapper script', async () => {
  // Like /usr/local/bin/tailscale: a wrapper that starts the real CLI without replacing itself.
  // The "real" CLI prints the approval link and then waits (as tailscale serve does).
  await fakeCli(
    `sh -c 'echo $$ > "${'$'}{0}"; echo "To enable, visit: https://login.tailscale.com/f/serve?node=abc"; sleep 30' "$(dirname "$0")/inner.pid"; echo done`,
  )
  const started = Date.now()
  await expect(serveGateway(4311)).rejects.toThrow('https://login.tailscale.com/f/serve?node=abc')
  expect(Date.now() - started).toBeLessThan(5_000)
  const inner = Number(await readFile(join(directory, 'inner.pid'), 'utf8'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  // The waiting serve is gone, so it can't finish serving later.
  expect(() => process.kill(inner, 0)).toThrow()
})

it('points to the admin page when HTTPS isn’t enabled for the tailnet', async () => {
  await fakeCli(
    `echo "Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve?node=abc"; exit 1`,
  )
  await expect(serveGateway(4311)).rejects.toThrow(
    'Turn on HTTPS (Serve) for your tailnet first: https://login.tailscale.com/f/serve?node=abc',
  )
})

it('removes only its own serve entry', async () => {
  const ours = {
    TCP: { '8443': { HTTPS: true } },
    Web: { 'mac.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4311' } } } },
  }
  expect(servesGateway(ours, 4311)).toBe(true)
  expect(servesGateway(ours, 9999)).toBe(false)
  expect(servesGateway({}, 4311)).toBe(false)
  await fakeCli(`if [ "$1 $2" = "serve status" ]; then echo '${JSON.stringify(ours)}'; fi`)
  await stopServingGateway(4311)
  expect(await calls()).toEqual(['serve status --json', 'serve --https=8443 off'])
  // Someone else's serve on that port is left alone.
  const theirs = {
    Web: { 'mac.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } },
  }
  await fakeCli(`if [ "$1 $2" = "serve status" ]; then echo '${JSON.stringify(theirs)}'; fi`)
  await stopServingGateway(4311)
  expect(await calls()).toEqual(['serve status --json'])
})
