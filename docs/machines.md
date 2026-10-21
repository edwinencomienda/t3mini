# Machines (developer guide)

Use t3 mini on another computer (a VPS, another Mac) from this one. Pair a machine once; from then on its projects and threads are in this computer's sidebar (**the hub**), and you can add projects and start threads on it from here. Its agents, files, and sign-ins stay on that machine. **Open** in Settings → Machines still shows the machine's whole t3 mini in a tab. Not yet: helpers on other machines (orchestration).

## Using it

1. On the other machine, install and start `t3mini` (see the README's **Install**) with Claude Code and/or Codex signed in there, and Tailscale signed in to the same tailnet as this Mac.
2. Get a pairing link there: in its t3 mini, **Settings → Machines → Add this computer to another t3 mini → Get a pairing link** (pick Tailscale or Local network; **Copy link**), or run `t3mini pair` in a terminal (`--lan` for the local network). Either way it turns on that machine's gateway for other devices if it's off and makes a one-time link, valid 5 minutes, usable once. (Switching an active connection to the other kind asks first, since it drops devices using the old one.)
3. On this Mac: **Settings → Machines**, paste the link (and a name if you like), **Add machine**.
4. **Open** shows the machine's t3 mini in a new tab at a local address, `http://127.0.0.1:<port>`. Its threads, projects, agents, and files are all on that machine.

**Remove** forgets the machine here and closes its address. To disconnect fully, also revoke this Mac on the other machine (Settings → Devices, where it's listed as `t3 mini · <this Mac's name>`).

## The hub: one sidebar for every machine

- **What you see:** each online machine's threads join this sidebar, ⌘K, and the Done / Question labels, with a small machine tag on its projects (in the sidebar, the New thread list, and the header). Click one and it opens here, in the same window: read it, send, steer, stop, approve, rename, delete, change its model, attach images. Images, media, and HTML the agent showed load from the machine. Offline machines drop out of the list until they answer again (checked every minute).
- **Creating:** **New thread** lists every machine's projects; picking one creates the thread there. The **+** on a machine's project does the same. **Add project** has an **On: This Mac | <machine>** choice; on a machine you type the path (Browse is this Mac's Finder). If the folder doesn't exist, **Create it and add** makes it (with any missing parents), only inside that computer's home folder. Add project always starts at `~/`.
- **How:** the browser only talks to this server. `/api/m/<machine>/<path>` (`Machines.forward()` in `machines.ts`) forwards to the machine's `/api/<path>` with the session this server holds, streaming both ways (Server-Sent Events, media). Only what threads need is forwarded (`hubPaths`: bootstrap, events, threads, uploads, media, html, projects, models, search); device access, machines, settings, and dictation aren't. Request cookies and `x-t3-*` headers aren't passed on, and the machine's `Set-Cookie` never comes back.
- **Ids:** in the browser a machine's thread is `m~<machine id>~<thread id>`, and its project folder `m~<machine id>~<path>` (`src/hub.ts`), so a machine's `/home/me/app` never merges with this computer's, and every call for it goes to the right place (`threadApi()`; content via the `ApiBase` context). Each machine has its own live stream (`/api/m/<id>/events`), merged in `Workspace.tsx`; the open machine thread's details come from its machine's stream.
- **Only on this computer** for a machine's thread: Open in VS Code, Project settings, renaming or removing its project, and Copy link (`read_thread` here can't read a machine's threads). A paired phone doesn't see machines (managing them is Mac-only).
- **Versions:** creating folders needs the machine to run a t3 mini with this feature; an older one ignores `create` and answers "does not exist".

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

- Hub: search inside a machine's messages in ⌘K (today ⌘K's message search covers this computer), a machine's processes and browser chip, dropped-file paths (they're this computer's), a machine filter in the sidebar, and helper reports from a machine's lead threads linking to hub ids.
- Show which machine a tab is on in **Open**'s tab (its title or header); today it looks like any t3 mini.
- Longer-lived or renewing machine sessions.
- Orchestration across machines (`start_thread` with a machine): this Mac's server already holds each machine's session and can call its API.
- SSH pairing (`ssh <host> 't3mini pair --json'` plus a tunnel) for machines without Tailscale.

## Testing

`src/server/machines.test.ts` runs against a fake gateway: pairing, the 0600 file, header rewriting, cookie and redirect handling, the Origin and Host checks, removal, and link validation. End to end on one Mac: run two `t3mini` copies with different `T3_MINI_HOME` and ports (`PORT`, `T3_MINI_PHONE_PORT`), `t3mini pair --lan --json` on one, add the link on the other, then open the machine's address.
