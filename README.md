<img src="branding/icon.png" width="72" align="right" alt="">

# Unraid Reverse Proxy

Give every Docker container on your Unraid server a name.

Instead of remembering `192.168.254.254:8080`, you open **`openwebui.local`**. Instead of
`192.168.254.254:8989`, **`sonarr.local`**. You add the mapping once in a web form and it works
from every machine on your network — no router settings, no Pi-hole entries, no editing
`hosts` files on each device.

```
                     openwebui.local ─┐
                        sonarr.local ─┤                  ┌─ 192.168.254.254:8080
                          plex.local ─┼─▶  this proxy  ──┼─ 192.168.254.254:8989
                 homeassistant.local ─┘   (port 80)      └─ 192.168.254.254:32400
```

---

## Why this exists

A reverse proxy alone **cannot** give you `openwebui.local`. Two separate things have to happen:

1. **Name resolution** — something on the network has to answer "what IP is `openwebui.local`?"
2. **Host routing** — something has to receive that request and forward it to the right container.

Nginx Proxy Manager, SWAG, Traefik and Caddy all do step 2 well, but none of them do step 1 — you
still have to hand-add a DNS record somewhere for every single service. This app does both. It
runs an **mDNS responder** (the same protocol behind `tower.local` and AirPlay) that answers for
every hostname you configure, so clients find it with zero configuration.

> `.local` is reserved for mDNS by [RFC 6762](https://www.rfc-editor.org/rfc/rfc6762). Putting
> `.local` records into a normal DNS server — a common workaround — misbehaves on Apple devices
> in particular. Answering over mDNS is the correct way to do this.

Unraid does not ship anything like this. It runs avahi (which is why `tower.local` resolves), but
avahi only advertises the server itself, not per-container aliases. The Docker tab's WebUI links
are a list of `ip:port` links with no hostnames and no proxying.

## What you get

| | |
|---|---|
| **Launch screen** | A dashboard listing every service as a tile with a live up/down dot and instant search |
| **Reverse proxy** | Routes by `Host` header, with WebSocket support, streaming/SSE, and redirect rewriting |
| **mDNS responder** | Advertises every hostname you configure, so `.local` resolves LAN-wide |
| **Admin panel** | Add, edit, reorder, enable and disable routes behind a login |
| **Icon library** | Search ~3,900 icons from the Unraid Community Applications catalogue, or upload your own |
| **Health checks** | Each upstream is TCP-probed on an interval; the dashboard shows what is down |
| **Backup** | Export and import the whole configuration as JSON |

No npm dependencies — the app uses only the Node standard library. The image is 108 MB.

---

## Installing on Unraid

### The one thing you must get right

**Give this container its own IP address on your LAN.** In the Docker template set:

- **Network Type:** `Custom : br0`
- **Fixed IP address:** something outside your DHCP pool, e.g. `192.168.254.20`

This matters for two reasons:

1. **Port 80 is already taken.** The Unraid webGUI owns port 80 on the host. A container with its
   own IP has its own port 80, so your URLs stay clean — `openwebui.local`, not
   `openwebui.local:8080`.
2. **mDNS needs real multicast.** Docker's default bridge network does not carry multicast to the
   LAN, so `.local` names would resolve to `172.17.x.x` — an address nothing outside the server
   can reach.

If you start it on the default bridge anyway, the container says so loudly in its log **and** on
the admin panel's System tab. That warning is not cosmetic; nothing will work until you fix it.

> Prefer not to use `br0`? Host networking (`--network=host`) also works, but then you must move
> the Unraid webGUI off port 80 first (Settings → Management Access), or run this on another port
> and accept `openwebui.local:8080` style URLs.

### Steps

1. **Apps → search for this template**, or add the template URL manually.
2. Set **Network Type** to `Custom : br0` and give it a **Fixed IP**.
3. Set **Config Storage** to `/mnt/user/appdata/unraid-reverse-proxy`.
4. Leave **HTTP Port** at `80`.
5. Apply, then browse to the IP you assigned.
6. Create your login on the setup screen. Nothing is preconfigured and there is no default
   password.
7. Add your first service and open `http://<hostname>.local`.

The template in [`unraid/unraid-reverse-proxy.xml`](unraid/unraid-reverse-proxy.xml) has
`nickhighland` placeholders — replace them with wherever you publish the image and icon.

### Running it anywhere else

```bash
docker compose up -d
```

`docker-compose.yml` uses host networking and port 8088 so it does not fight anything.

---

## Using it

### Adding a service

Click **+ Add service** and fill in three things:

| Field | Example |
|---|---|
| Display name | `Open WebUI` |
| Hostname | `openwebui` → becomes `openwebui.local` |
| Target address / port | `192.168.254.254` / `8080` |

You can paste `192.168.254.254:8080` straight into the address box and the port splits out
automatically. **Test connection** probes the address before you save.

### Icons

**Browse library** searches the Unraid Community Applications catalogue — about 3,900 app icons,
the same ones you see in Apps. Search "plex" and you get Plex; the list is ranked so the real app
comes before companion tools.

The catalogue index is fetched on first use (~1 second, cached in `/config/icon-index.json`,
refreshed weekly). Choosing an icon downloads a copy into `/config/icons/` so your dashboard keeps
working even if the original host disappears. You can also **Upload…** your own PNG/JPEG/SVG, or
paste any image URL. Leave it blank and the tile shows the service's initials in your chosen
colour.

### The advanced toggles

Defaults are right for almost everything; open **Advanced** if something misbehaves.

| Toggle | Default | Turn it off when |
|---|---|---|
| Forward WebSockets | on | Never, unless you are debugging |
| Preserve Host header | on | The app rejects the `.local` hostname or redirects oddly |
| Rewrite redirects | on | The app already generates correct external URLs |
| Ignore TLS certificate errors | off | The target is HTTPS with a self-signed certificate |
| Show on dashboard | on | You want the route but not the tile |

---

## Domain suffixes

`.local` is the default, not the only option. **Settings → Domain suffixes** takes a list, and
every service answers on all of them at once — `plex.local`, `plex.home.arpa` and `plex.lan` can
all reach the same container. The first suffix in the list is the "primary": it is what the
dashboard links to and what the admin panel displays.

There is one thing that makes `.local` special:

> **Only `.local` resolves by itself.** mDNS is defined for the `.local` domain and nothing else
> ([RFC 6762 §3](https://www.rfc-editor.org/rfc/rfc6762#section-3)). Clients never send lookups for
> other suffixes to the multicast group, so the responder deliberately only claims `.local` names.

Every other suffix works exactly as well for routing — the proxy matches the `Host` header either
way — but something has to answer the name lookup. That is **one wildcard record**, not one per
service. The settings screen shows you the exact record to create:

```
*.home.arpa   A   192.168.254.20
```

Add that in Pi-hole (Local DNS → DNS Records), AdGuard Home (Filters → DNS rewrites), or your
router, and every service you ever add is covered without touching DNS again.

### Choosing one

| Suffix | Resolves itself | Notes |
|---|---|---|
| `local` | **Yes**, via mDNS | Zero setup. Android support is inconsistent. |
| `home.arpa` | No | Reserved for home networks by [RFC 8375](https://www.rfc-editor.org/rfc/rfc8375). The formally correct choice. |
| `internal` | No | Reserved for private use by ICANN in 2024. Safe and short. |
| `lan`, `home`, `box` | No | Common conventions, not delegated publicly. Fine in practice. |
| `dev`, `app`, `zip`, `mov` | No | **Do not use.** See below. |

A practical combination is `local` primary with `home.arpa` alongside: Apple and Windows machines
get zero-config names, and anything with patchy mDNS (Android, some IoT devices) uses the DNS
suffix instead.

### Suffixes to avoid

`.dev`, `.app`, `.zip`, `.mov`, `.page` and the rest of Google's TLDs are on the
[HSTS preload list](https://hstspreload.org/) — **browsers force HTTPS on the entire zone before a
request is even sent**. A plain-HTTP proxy on those names cannot work, and no amount of
configuration will fix it. The app warns you if you try.

Inventing a suffix like `.nas` also works today but is a bet that it never becomes a real TLD.
`.internal` and `.home.arpa` exist precisely so you do not have to make that bet.

### Client support for `.local`

| Platform | Works out of the box? |
|---|---|
| macOS, iOS, iPadOS | Yes — mDNS is built in |
| Windows 10 (1703+) and Windows 11 | Yes |
| Linux | Yes, if `avahi-daemon` / `nss-mdns` is installed (most desktops ship it) |
| Android | **Partial** — Chrome on Android resolves `.local` inconsistently |
| Older Windows | Needs Apple Bonjour installed |

---

## Troubleshooting

**`.local` names don't resolve at all.**
Check the System tab. If Advertised IP is `172.17.x.x` you are on the Docker bridge — see the
setup section above. If the mDNS responder says *stopped*, port 5353 is already claimed on the
host; giving the container its own IP on `br0` resolves that too, since it gets its own network
stack.

**The name resolves but the page doesn't load.**
The proxy is reachable and the container behind it isn't. The error page names the exact address
it tried. Check the dashboard's status dot and use **Test connection** in the edit form.

**The app loads but looks broken, or login bounces you out.**
Turn off **Preserve Host header** for that service. Some apps compare the `Host` header against a
configured base URL and get upset.

**Port 80 won't bind.**
Something else has it — on Unraid that is the webGUI. Give the container its own IP on `br0`.

**Everything worked, then stopped after an Unraid reboot.**
Confirm the container's fixed IP is still outside your DHCP pool and wasn't handed to another
device.

---

## Development

```bash
npm start           # CONFIG_DIR=/config, port 80
npm run dev         # CONFIG_DIR=./data, port 8088
npm test            # 50 tests, no network required
```

```
src/
├── server.js              routing: Host header → proxy, otherwise the admin app
├── lib/
│   ├── config.js          load/save/validate config.json
│   ├── auth.js            scrypt passwords, HMAC session cookies, login throttling
│   ├── proxy.js           HTTP forwarding, WebSocket upgrades, redirect rewriting
│   ├── mdns.js            RFC 6762 responder — DNS wire format, announcements
│   ├── icons.js           Community Applications icon index, search, local cache
│   ├── health.js          TCP probes
│   └── netinfo.js         interface detection, Docker-bridge detection
├── routes/api.js          REST API
└── public/                dashboard, admin panel, login (no build step)
```

Everything is stored in `/config`:

```
config.json        routes, settings, your password hash
icon-index.json    cached catalogue index (~600 KB, rebuilt weekly)
icons/             locally cached icon images
```

### Security notes

This is a LAN tool and is designed as one. Passwords are hashed with scrypt; sessions are
HMAC-signed, `HttpOnly`, `SameSite=Lax` cookies; failed logins are throttled per IP. Traffic
between clients and the proxy is **plain HTTP** — `.local` names cannot get a public TLS
certificate, so there is nothing to be gained from a self-signed one here. Do not expose this
container to the internet.

The dashboard is readable without signing in by default, so it works as a one-click launcher;
it deliberately does not expose upstream addresses to anonymous visitors. Turn on **Require
sign-in for the dashboard** in Settings if you would rather it were private.

## Licence

MIT
