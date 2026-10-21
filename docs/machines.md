# Machines (developer guide)

Use t3 mini on another computer (a VPS, another Mac) from this one. Step 1 of the multi-machine plan: pair a machine and open its t3 mini from here. Not yet: a merged sidebar across machines, and helpers on other machines (orchestration).

## Using it

1. On the other machine, install and start `t3mini` (see the README's **Install**) with Claude Code and/or Codex signed in there, and Tailscale signed in to the same tailnet as this Mac.
2. Get a pairing link there: in its t3 mini, **Settings → Machines → Add this computer to another t3 mini → Get a pairing link** (pick Tailscale or Local network; **Copy link**), or run `t3mini pair` in a terminal (`--lan` for the local network). Either way it turns on that machine's gateway for other devices if it's off and makes a one-time link, valid 5 minutes, usable once. (Switching an active connection to the other kind asks first, since it drops devices using the old one.)
3. On this Mac: **Settings → Machines**, paste the link (and a name if you like), **Add machine**.
4. **Open** shows the machine's t3 mini in a new tab at a local address, `http://127.0.0.1:<port>`. Its threads, projects, agents, and files are all on that machine.

**Remove** forgets the machine here and closes its address. To disconnect fully, also revoke this Mac on the other machine (Settings → Devices, where it's listed as `t3 mini · <this Mac's name>`).

## How it works

```text
Browser on this Mac ──► 127.0.0.1:<port>  (machines.ts: MachineProxy, loopback only)
                          1. Host must be 127.0.0.1/localhost:<port>, from loopback; any Origin must be it
                          2. Drop the browser's cookies, x-t3-*, x-forwarded-*, tailscale-* headers
                          3. Host/Origin → the machine's gateway; add its session cookie
                      ──► https://<machine>.<tailnet>.ts.net:8443  (its remote.ts gateway)
                          the usual device checks; its app sees a paired device (x-t3-remote)
```

- **Pairing reuses the phone gateway** (`remote.ts`). The other machine sees this Mac as one more paired device, so there's no new way into a machine: same one-time codes, hashed revocable sessions, Tailscale or private-network-only checks. `deviceName()` labels it `t3 mini · <host>` from this Mac's user agent (`t3mini/<version> (<host>)`).
- **The session stays on this server.** `Machines.add()` POSTs the code to the machine's `/pair`, keeps the `Set-Cookie` session in `machines.json` next to the data (mode 0600), and checks that `/api/bootstrap` answers. The API (`GET/POST/DELETE /api/machines`, `POST /api/machines/rename`) never returns it, and it's never sent to a browser: the proxy adds it and strips any `Set-Cookie` the machine sends back.
- **A local address per machine,** from the app's port + 100 up (production 4111…, dev 4116…), saved per machine and moved if taken. HTTP, Server-Sent Events, and WebSockets (dictation) pass through; redirects to the machine come back to the local address.
- **Mac-only actions** (Open in VS Code, folder picker, its Settings → Devices and Dictation) are refused by the machine, since the request arrives as a paired device.
- **Links:** `https://` for any host (Tailscale), `http://` only for private network addresses.
- **Status** (`list()`): online (its `/api/bootstrap` answers), offline, or unpaired (401: the session expired or was revoked).
- Code: `src/server/machines.ts` (store, pairing, proxy), `/api/machines` in `api.ts`, `components/Machines.tsx` (Settings → Machines: adding machines, and `ShareThisComputer`, the in-app `t3mini pair` built on `/api/remote` and `/api/remote/pair`), `t3mini pair` in `cli/t3mini.ts`.

## Security

- Machine access lets this Mac control agents that run commands on that machine, so treat each pairing like an SSH key. Use Tailscale: the local-network mode is plain HTTP and only for networks you trust (and it turns off when the other t3 mini restarts, so the machine goes offline).
- The local address has no login of its own, like t3 mini itself: anything running on this Mac as you can use it. It refuses other sites (Origin) and other host names (DNS rebinding).
- The session lasts 30 days (the gateway's device sessions); after that the machine shows **unpaired**: remove it and pair again.

## Follow-ups

- Show which machine a tab is on (its title or header); today it looks like any t3 mini.
- Longer-lived or renewing machine sessions.
- A merged sidebar (machine labels, New thread on any machine) and orchestration across machines (`start_thread` with a machine): this Mac's server already holds each machine's session and can call its API.
- SSH pairing (`ssh <host> 't3mini pair --json'` plus a tunnel) for machines without Tailscale.

## Testing

`src/server/machines.test.ts` runs against a fake gateway: pairing, the 0600 file, header rewriting, cookie and redirect handling, the Origin and Host checks, removal, and link validation. End to end on one Mac: run two `t3mini` copies with different `T3_MINI_HOME` and ports (`PORT`, `T3_MINI_PHONE_PORT`), `t3mini pair --lan --json` on one, add the link on the other, then open the machine's address.
