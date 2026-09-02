# Changelog

## 1.0.0

First release.

### Added

- **Reverse proxy** routing by `Host` header to any container on the network, with WebSocket
  upgrades, streaming/SSE support, hop-by-hop header handling per RFC 9110, and rewriting of
  upstream redirects that point back at a raw `ip:port`.
- **Built-in mDNS responder** (RFC 6762) so `.local` names resolve on the LAN with no DNS
  configuration anywhere else. Implemented against the Node standard library — no Avahi
  dependency, no npm packages.
- **Multiple domain suffixes.** Every service answers on all of them at once, so `plex.local`,
  `plex.home.arpa` and `plex.lan` can reach the same container. The settings screen states which
  suffixes resolve by themselves and prints the exact wildcard DNS record for the ones that do
  not, and warns about HSTS-preloaded TLDs such as `.dev` and `.app`, where plain HTTP cannot work.
- **Launch screen** listing every service with live up/down indicators, instant search, and a
  keyboard shortcut.
- **Admin panel** behind a login: add, edit, reorder, enable and disable routes. Passwords are
  hashed with scrypt; sessions are HMAC-signed `HttpOnly` cookies; failed logins are throttled.
- **Icon library** backed by the Unraid Community Applications catalogue — roughly 3,900 icons,
  searched on demand and distilled to a ~600 KB local index rather than bundled. Chosen icons are
  copied into `/config` so tiles survive the source host going away. Custom uploads and pasted
  URLs are supported too.
- **Health checks** that TCP-probe each upstream on an interval.
- **Configuration export and import** as JSON.
- Startup and admin-panel warnings when the container is running on a Docker bridge address,
  which is the one misconfiguration that silently breaks name resolution.

### Notes

- The image is 108 MB and has no runtime dependencies beyond a Node runtime.
- 63 tests cover the mDNS wire format, proxy header handling, suffix rules, config migration and
  the full HTTP surface. None of them need network access.
