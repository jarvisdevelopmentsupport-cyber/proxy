# Relay Proxy

A rebuild of the custom URL relay proxy originally hosted at
`logistical-utilities.vercel.app/api/relay`. The original source was lost, so this
version was reconstructed by probing the live endpoint and capturing its exact
behavior — including the client-side interception script it injected into HTML
responses, which was recovered verbatim from its output.

This is a faithful reconstruction of the original relay's observed behavior. It
is not a general-purpose transparent proxy: it proxies HTML, CSS, and static
assets and reroutes client-side GET/HEAD requests, but it does not proxy
authentication state, WebSocket traffic, or arbitrary POST bodies.

## One repo, two hosts

The relay logic lives in one shared handler, `lib/relay.js`, with two thin entry
points — so the same GitHub repo deploys to both **Vercel** and **Render**
without any changes:

| Platform | Entry point | How it runs | Endpoint |
|---|---|---|---|
| Vercel | `api/relay.js` | Serverless function (Vercel auto-deploys files in `api/`) | `https://<project>.vercel.app/api/relay` |
| Render (or any Node host) | `server.js` | Plain Node server via `npm start` | `https://<service>.onrender.com/api/relay` |

Both serve the exact same path (`/api/relay`), so your client code works with
either deployment — only the domain changes.

## Deploying from GitHub

1. Push this folder to a GitHub repo.
2. **Vercel**: vercel.com → Add New Project → import the repo → Deploy.
   (Or with the CLI: `npm i -g vercel && vercel`.)
3. **Render**: render.com → New Web Service → connect the repo:
   - Build command: `npm install`
   - Start command: `npm start`
   - That's it — the server listens on Render's injected `PORT` and derives
     `https://` URLs from Render's forwarded headers automatically.

No environment variables are needed on either platform — the function uses only
Node's built-in `fetch` (Node 18+).

### Platform notes

- **Vercel**: supports the Node-style `(req, res)` handler with helpers like
  `res.status()`/`res.send()` ([Node runtime docs](https://vercel.com/docs/functions/runtimes/node-js)),
  and [caps function request/response bodies at 4.5 MB](https://vercel.com/docs/functions/limitations) —
  the original relay had the same limit. Project-wide settings like `maxDuration`
  are documented in the [vercel.json reference](https://vercel.com/docs/project-configuration/vercel-json).
  This repo has no framework dependencies, so Vercel's import-time framework
  detection falls back to the "Other" preset ([build settings docs](https://vercel.com/docs/builds/configure-a-build))
  and deploys the `api/` functions — if it ever auto-detects a framework you
  don't use, set Framework Preset to "Other" in project settings.
- **Render**: web services must bind `0.0.0.0` and the injected `PORT`
  environment variable ([web services docs](https://render.com/docs/web-services)) —
  `server.js` does exactly that. Node.js version selection follows
  `NODE_VERSION` / `.node-version` / `engines` in that order, and Render
  recommends bounded ranges ([Node version docs](https://render.com/docs/node-version)) —
  this repo pins `engines.node: "24.x"`, which matches Render's current
  default (24.22.1) and Vercel's default (24).

## Client integration

Same pattern as before — just point `relayUrl` at whichever deployment you use:

```js
const relayUrl = "https://<your-deployment>.vercel.app";   // or ...onrender.com
const targetUrl = "https://core-logic-utils.github.io";
const C = relayUrl + "/api/relay?url=" + encodeURIComponent(targetUrl + "/tabspace.html");

fetch(C)
    .then(function(D) {
        if (!D.ok) throw new Error("x");
        return D.text();
    })
    .then(function(E) {
        let F = E;
        if (F.indexOf("<head>") !== -1) {
            F = F.replace("<head>", "<head><base href=\"" + targetUrl + "/\">");
        } else {
            F = "<base href=\"" + targetUrl + "/\">" + F;
        }
        // Render inside an iframe so scripts execute:
        const frame = document.createElement("iframe");
        frame.style.cssText = "width:100%;height:100vh;border:0;";
        frame.srcdoc = F;
        document.body.appendChild(frame);
    });
```

Notes:

- Use `iframe.srcdoc` (as above), not `innerHTML` — scripts inserted via
  `innerHTML` are not executed by browsers, including the relay's interception
  script.
- The base tag makes unresolved relative URLs load directly from the target
  site; it does not itself proxy anything. The relay's injected script and
  server-side rewrites handle the actual proxying.
- `data-no-proxy` is an opt-out for the runtime rewriting hooks only (the
  injected script skips elements carrying that attribute); the server-side
  HTML/CSS rewriting always runs.

## What it does

For each `GET /api/relay?url=<encoded target>`:

| Response type | Behavior |
|---|---|
| `text/html` | Injects the interception script right after `<head>` (prepended if no literal `<head>`), and rewrites absolute `src=`/`href=` attribute values to relay URLs |
| `text/css` | Rewrites `url(...)` references to absolute relay URLs, resolved against the CSS file's own URL |
| Anything else | Byte-for-byte passthrough (images, fonts, JS, JSON, ...) |

Other behaviors, matching the original:

- Upstream redirects are followed server-side (max 5 hops, each validated
  against the allowlist when one is configured); upstream status codes and
  content-types are passed through.
- `OPTIONS` returns `204` with CORS headers; every response (errors included)
  carries `Access-Control-Allow-Origin: *`.
- Responses are cacheable for 60 seconds.
- Errors are JSON: `400` missing/invalid `url`, `403` disallowed host,
  `500` upstream fetch failure, `405` non-GET methods.

The injected client-side script (recovered verbatim from the original):

- Proxies `fetch` and `XMLHttpRequest` — but only `GET`/`HEAD`, so `POST`
  uploads (e.g. profile pictures) go direct.
- Intercepts `setAttribute` and `src`/`href` property assignments on images,
  scripts, audio, links and iframes.
- Intercepts `Worker` constructors.
- Keeps link-click navigation inside the proxy.
- Opt-out: add a `data-no-proxy` attribute to an element to bypass the runtime
  rewriting hooks for that element.

## Configuration

All in `lib/relay.js`, top of the file — everything can also be set via
environment variables (set them in the Vercel or Render dashboard):

- **`RELAY_ALLOWED_HOSTS`** (env) — comma-separated host patterns; empty/omitted
  (default, matches the original) allows proxying any host. Sites that load
  assets from third-party CDNs (e.g. cdnjs) work unchanged in this mode. An
  allowlist works too — just include your sites AND the CDNs they reference,
  e.g. `RELAY_ALLOWED_HOSTS=core-logic-utils.github.io,*.github.io,cdnjs.cloudflare.com,cdn.tailwindcss.com`,
  or those assets will 403. Redirect destinations are validated against the same
  list before they are fetched. The equivalent code constant is `ALLOWED_HOSTS`.
- **`RELAY_PUBLIC_URL`** (env) — override the public origin used when the relay
  rewrites URLs (e.g. behind a custom domain). Otherwise the origin is derived
  from the request (`x-forwarded-proto` + `Host`), which works on both Vercel
  and Render.
- **`RELAY_TIMEOUT_MS`** (env) — upstream timeout covering redirects and body
  read (default 15000).
- **`MAX_REDIRECTS`** — max redirect hops (default 5), in `lib/relay.js`.

## Security notes

- The original relay was an open proxy (any URL, any host), and this rebuild
  defaults to the same so your sites work unchanged. Be aware an open relay on a
  public URL can be abused by third parties to fetch URLs through your function
  (SSRF-style) and consume your hosting usage. If that becomes a problem, set
  `RELAY_ALLOWED_HOSTS`.
- Only `http:`, `https:` and `data:` schemes are proxied; `file:` and other
  schemes are rejected.
- Cookies/authorization are never forwarded upstream.
- Target URLs are escaped when embedded into the injected script, so URLs
  containing quotes or `</script>` cannot break out of it (this is stricter than
  the original).

## Tests

```bash
npm test
```

Runs 47 checks against the live handler, including a byte-for-byte comparison of
the full proxied `tabspace.html` output against the original relay. The relay's
responses are bundled as fixtures in `test-fixtures/`, so those comparisons keep
working even if the old relay ever goes away — but the suite still fetches the
live target pages and CDNs, so it needs internet access.

## Local development

```bash
npm start          # http://localhost:3000/api/relay?url=...
```
