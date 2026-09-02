# Submitting to Community Applications

Everything on this side is ready. CA registration is a **forum post**, not a pull request, so the
last step needs your Unraid forum account — it can't be automated.

## How CA actually works

CA does not host templates. It keeps a list of ~1,190 *maintainer repositories* and rescans them
regularly, generating `applicationFeed.json`. You register a repository once; every template in it
is picked up, and every later change flows through automatically without another submission.

That means: **you submit the repository, not the app.** Future versions need no further action.

## Pre-flight — all verified

| Check | Status |
|---|---|
| Template is well-formed XML, no unbalanced tags, no unescaped `&` | ✅ |
| All required fields present (Name, Repository, Registry, Network, Support, Project, Overview, Category, Icon, WebUI, TemplateURL) | ✅ |
| Categories exist in CA's `categoryList.json` — `Network:Proxy`, `Network:DNS`, `Tools:Utilities` | ✅ |
| Every `<Config>` block has Name/Target/Type/Mode/Display/Required/Mask | ✅ |
| Image is public and pulls anonymously | ✅ |
| Image is multi-arch (linux/amd64 + linux/arm64) | ✅ |
| Icon URL returns a real PNG | ✅ |
| `TemplateURL` resolves to the raw XML | ✅ |
| Support URL is reachable | ✅ |

## The post to make

Go to the Unraid forums thread **"Community Applications — Add your repository here"**
(<https://forums.unraid.net/topic/38582-plug-in-community-applications/>, or search the forum for
that title — CA's maintainer pins the current thread). Post this:

> **Repository:** https://github.com/nickhighland/unraid-reverse-proxy
>
> **Maintainer:** nickhighland
>
> **Application:** Unraid Reverse Proxy — maps your Docker containers to `.local` hostnames.
>
> It runs a reverse proxy that routes by Host header together with an mDNS responder, so
> `sonarr.local` and friends resolve across the LAN with no DNS configuration on the router or on
> any client. Other suffixes (`home.arpa`, `internal`, `lan`) are supported alongside `.local`.
> There is a launch dashboard with live status, categories and drag ordering, and a
> password-protected admin panel.
>
> Template: `unraid/unraid-reverse-proxy.xml`
> Image: `ghcr.io/nickhighland/unraid-reverse-proxy` (public, amd64 + arm64)
> Support: https://github.com/nickhighland/unraid-reverse-proxy/issues
>
> Note for reviewers: the template sets `Network` to `br0` because the container needs its own LAN
> IP — port 80 on the host belongs to the webGUI, and mDNS needs real multicast. It also asks the
> user to run `docker network connect bridge <container>` once, because br0 is ipvlan and a
> container on it cannot reach its own host. The app detects that state and reports it in the log
> and in its System tab rather than failing silently.

## What happens next

1. CA's maintainer adds the repository to the scan list (usually a few days).
2. The next feed rebuild picks up the template; the app appears in **Apps** in Unraid.
3. Later releases need nothing: tag a new version, and the `:latest` image plus any template edits
   are picked up on the next scan.

## If it is rejected

The usual reasons and what to do:

- **"Needs a support thread."** CA prefers an Unraid forum support thread over GitHub issues.
  Create one in *Docker Containers* → *Docker Engine*, then change `<Support>` to that URL.
- **"Do not default to br0."** Some reviewers dislike templates that require a custom network.
  The honest answer is that this app cannot work on the default bridge — mDNS needs multicast to
  reach the LAN. Point at the Overview, which explains it up front.
