// /api/relay — URL relay proxy (rebuild)
// Reconstructed from the original logistical-utilities relay's observed behavior:
//   - GET /api/relay?url=<encoded target>
//   - Follows redirects server-side, passes through status + content-type
//   - HTML responses get a client-side interception script injected after <head>
//     (prepended when no literal <head> exists) so sub-resources, fetch/XHR,
//     workers and link navigation all route back through the relay
//   - HTML: absolute src=/href= attribute values are rewritten to relay URLs
//   - CSS responses get url(...) references rewritten to absolute relay URLs
//   - Everything else passes through byte-for-byte
//   - CORS: allow-origin * on every response, OPTIONS -> 204

// ---- CONFIG -----------------------------------------------------------------
// Everything here can also be set via environment variables (useful on Vercel):
//   RELAY_PUBLIC_URL      e.g. https://my-relay.vercel.app (overrides derived origin)
//   RELAY_ALLOWED_HOSTS   comma-separated host patterns; empty/omitted = open
//   RELAY_TIMEOUT_MS      upstream timeout in milliseconds

// Hosts allowed to be proxied. Empty array [] = allow any host, which is
// what the ORIGINAL relay did. This keeps sites working unchanged, but note
// that an allowlist containing your sites AND the CDNs they load assets from
// (e.g. cdnjs.cloudflare.com, cdn.tailwindcss.com) works equally well and is
// safer. Patterns: 'example.com' for exact hosts, '*.github.io' for subdomains.
const ALLOWED_HOSTS = (process.env.RELAY_ALLOWED_HOSTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Max ms to wait on the upstream fetch (covers redirects and body read)
const UPSTREAM_TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS) || 15000;

// Max redirect hops to follow
const MAX_REDIRECTS = 5;

// Upstream request headers to forward from the incoming request.
// Cookie/authorization are deliberately excluded: forwarding auth headers
// would let anyone use the relay with your credentials.
const FORWARD_REQUEST_HEADERS = ['accept', 'accept-language', 'user-agent'];

// ----------------------------------------------------------------------------

// The exact client-side interception script the original relay injected
// (recovered verbatim from its responses). Placeholders are substituted
// per-request: __PROXY_BASE__ and __TARGET_BASE__.
const SCRIPT = "\n\n      <script>\n        (function() {\n          const proxyBase = '__PROXY_BASE__';\n          const targetBase = '__TARGET_BASE__';\n          \n          function toProxy(url) {\n            if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#') || url.startsWith('blob:') || url.startsWith(proxyBase)) return url;\n            try { return proxyBase + encodeURIComponent(new URL(url, targetBase).href); }\n            catch(e) { return url; }\n          }\n          \n          // Intercept Fetch — only proxy GET/HEAD so uploads (POST) stay direct\n          const originalFetch = window.fetch;\n          window.fetch = function(input, init = {}) {\n            const method = ((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();\n            \n            // Leave POST/PUT/PATCH/DELETE alone (this fixes profile picture uploads)\n            if (method !== 'GET' && method !== 'HEAD') {\n              return originalFetch.call(this, input, init);\n            }\n\n            if (typeof input === 'string') {\n              input = toProxy(input);\n            } else if (input instanceof Request) {\n              input = new Request(toProxy(input.url), init);\n            }\n            return originalFetch.call(this, input, init);\n          };\n          \n          // Intercept XHR — only proxy GET/HEAD\n          const originalOpen = XMLHttpRequest.prototype.open;\n          XMLHttpRequest.prototype.open = function(method, url, ...args) {\n            if (String(method).toUpperCase() === 'GET' || String(method).toUpperCase() === 'HEAD') {\n              url = toProxy(url);\n            }\n            return originalOpen.call(this, method, url, ...args);\n          };\n\n          // Intercept setAttribute with opt-out\n          const originalSetAttribute = Element.prototype.setAttribute;\n          Element.prototype.setAttribute = function(name, value) {\n            if (['src', 'href', 'action'].includes(name.toLowerCase()) && typeof value === 'string' && !this.hasAttribute('data-no-proxy')) {\n              value = toProxy(value);\n            }\n            return originalSetAttribute.call(this, name, value);\n          };\n\n          // Intercept property assignments dynamically with opt-out\n          ['src', 'href'].forEach(attr => {\n            const prototypes = [HTMLImageElement, HTMLScriptElement, HTMLAudioElement, HTMLLinkElement, HTMLIFrameElement];\n            prototypes.forEach(proto => {\n              if (!proto) return;\n              const desc = Object.getOwnPropertyDescriptor(proto.prototype, attr);\n              if (desc && desc.set) {\n                const originalSet = desc.set;\n                Object.defineProperty(proto.prototype, attr, {\n                  set: function(val) {\n                    if (this.hasAttribute('data-no-proxy')) {\n                      originalSet.call(this, val);\n                    } else {\n                      originalSet.call(this, toProxy(val));\n                    }\n                  },\n                  get: desc.get\n                });\n              }\n            });\n          });\n\n          // Intercept Web Workers \n          if (window.Worker) {\n            const originalWorker = window.Worker;\n            window.Worker = function(url, options) {\n              return new originalWorker(toProxy(url), options);\n            };\n          }\n          \n          // Keep navigation inside the iframe unless opted out\n          document.addEventListener('click', function(e) {\n            const a = e.target.closest('a');\n            if (a && a.hasAttribute('href') && !a.hasAttribute('data-no-proxy')) {\n              const href = a.getAttribute('href');\n              if (!href.startsWith('javascript:') && !href.startsWith('#')) {\n                e.preventDefault();\n                window.location.href = toProxy(href);\n              }\n            }\n          }, true);\n        })();\n      </script>";

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function hostAllowed(hostname) {
  if (!ALLOWED_HOSTS.length) return true; // open mode, matches original
  return ALLOWED_HOSTS.some(pattern => {
    if (pattern.startsWith('*.')) {
      return hostname.endsWith(pattern.slice(1)); // ".github.io"
    }
    return hostname === pattern;
  });
}

function sendError(res, status, message) {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json({ error: message });
}

export default async function handler(req, res) {
  // CORS on every response, including errors
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'Method not allowed');
  }

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return sendError(res, 400, 'Missing "url" query parameter');
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return sendError(res, 400, 'Invalid URL');
  }

  // Only http/https/data can be proxied; other schemes (file:, etc.) rejected
  const schemeOk =
    parsed.protocol === 'http:' ||
    parsed.protocol === 'https:' ||
    parsed.protocol === 'data:';
  if (!schemeOk) {
    return sendError(res, 400, 'Only http, https and data URLs are supported');
  }

  if (parsed.hostname && !hostAllowed(parsed.hostname)) {
    return sendError(res, 403, 'Target host is not allowed');
  }

  // Forward a few safe headers upstream
  const forwardHeaders = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    if (req.headers[name]) forwardHeaders[name] = req.headers[name];
  }

  // Fetch the target, following redirects MANUALLY so every destination is
  // checked against the allowlist before it is requested, with one timeout
  // covering the whole redirect chain and body read.
  let upstream;
  try {
    upstream = await fetchUpstream(parsed.href, forwardHeaders);
  } catch (err) {
    return sendError(res, err.status || 500, err.message);
  }

  const contentType = upstream.contentType;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=60');

  const relayBase = process.env.RELAY_PUBLIC_URL || relayOrigin(req);
  const proxyBase = `${relayBase}/api/relay?url=`;

  const isHtml = contentType.includes('text/html');
  const isCss = contentType.includes('text/css');

  if (isHtml) {
    let body = upstream.body.toString('utf8');
    const script = SCRIPT
      .replace('__PROXY_BASE__', () => escapeJsString(proxyBase))
      .replace('__TARGET_BASE__', () => escapeJsString(targetUrl));

    // Rewrite absolute src/href attribute values (http:, https:, mailto:, ...)
    // to relay URLs, matching the original relay. Relative values, data:,
    // javascript:, blob: and #fragments are left for the client script.
    body = rewriteHtmlAttributes(body, proxyBase);

    const headIndex = body.indexOf('<head>');
    if (headIndex !== -1) {
      const insertAt = headIndex + '<head>'.length;
      body = body.slice(0, insertAt) + script + body.slice(insertAt);
    } else {
      body = script + body;
    }
    return res.status(upstream.status).send(body);
  }

  if (isCss) {
    const css = upstream.body.toString('utf8');
    return res.status(upstream.status).send(rewriteCssUrls(css, parsed.href, proxyBase));
  }

  // Raw passthrough (images, fonts, JS, JSON, ...)
  return res.status(upstream.status).send(upstream.body);
}

class UpstreamError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

// Fetch url (following redirects manually, validating each hop against the
// allowlist) and read the full body — all under a single timeout.
// Returns { status, contentType, body: Buffer }.
async function fetchUpstream(startUrl, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    let current = startUrl;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) throw new UpstreamError('Too many redirects');
      const res = await fetch(current, {
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
      const location = isRedirect ? res.headers.get('location') : null;
      if (!location) {
        // Final response (or a redirect without Location) — read the body
        // while the timeout is still armed.
        const contentType = res.headers.get('content-type') || 'application/octet-stream';
        const body = Buffer.from(await res.arrayBuffer());
        return { status: res.status, contentType, body };
      }
      let next;
      try {
        next = new URL(location, current).href;
      } catch {
        throw new UpstreamError('Failed to fetch the target URL');
      }
      if (ALLOWED_HOSTS.length) {
        let nextHost = '';
        try {
          nextHost = new URL(next).hostname;
        } catch {
          nextHost = '';
        }
        if (nextHost && !hostAllowed(nextHost)) {
          throw new UpstreamError('Redirect target is not allowed', 403);
        }
      }
      current = next;
    }
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    // AbortError (timeout) or network failure
    throw new UpstreamError('Failed to fetch the target URL');
  } finally {
    clearTimeout(timer);
  }
}

// Derive the relay's public origin from the request. Vercel terminates TLS
// and forwards x-forwarded-proto: https; plain local HTTP has no such header.
function relayOrigin(req) {
  const host = req.headers.host || 'localhost:3000';
  const proto =
    req.headers['x-forwarded-proto'] ||          // Vercel and most proxies
    req.headers['x-forwarded-ssl'] ||             // some other proxies
    (process.env.RENDER === 'true' ? 'https' : '') || // Render (RENDER env is documented)
    (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

// Escape a value for safe embedding inside a single-quoted JS string literal
// within an inline <script>: neutralizes quote/backslash/newline breaks and
// </script> sequence breakouts.
function escapeJsString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/</g, '\\u003C');
}

// Rewrite src= / href= attribute values in HTML to relay URLs.
// Mirrors the original relay exactly: the pattern tolerates whitespace around
// the = sign and re-emits the attribute normalized (src="value", same quote
// character). Only values that parse as absolute URLs (http:, https:, mailto:,
// ...) are proxied; data:, javascript:, blob: and relative/fragment values are
// re-emitted unchanged (the injected client script handles relative refs).
function rewriteHtmlAttributes(html, proxyBase) {
  return html.replace(/((?:src|href)\s*=\s*)(["'])([^"']*)(["'])/g,
    (match, open, quote, value, close) => {
      if (/^(data|javascript|blob):/i.test(value) || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
        return `${open.replace(/\s*=\s*/, '=')}${quote}${value}${close}`;
      }
      try {
        const resolved = new URL(value).href;
        return `${open.replace(/\s*=\s*/, '=')}${quote}${proxyBase}${encodeURIComponent(resolved)}${close}`;
      } catch {
        return `${open.replace(/\s*=\s*/, '=')}${quote}${value}${close}`;
      }
    });
}

// Rewrite url(...) references in CSS to absolute relay URLs,
// resolved against the CSS file's own URL.
function rewriteCssUrls(css, cssUrl, proxyBase) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _quote, rawUrl) => {
    const trimmed = rawUrl.trim();
    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('data:') ||
      trimmed.includes('/api/relay?url=') // already proxied
    ) {
      return match;
    }
    let resolved;
    try {
      resolved = new URL(trimmed, cssUrl).href;
    } catch {
      return match;
    }
    return `url(${proxyBase}${encodeURIComponent(resolved)})`;
  });
}
