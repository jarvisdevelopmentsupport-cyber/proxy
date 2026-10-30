// Direct handler tests — invokes the Vercel handler with mock req/res.
// Usage: node test-handler.mjs
// Fixtures are downloaded on demand into test-fixtures/ (and shipped with the
// archive), so the byte-for-byte comparisons against the original relay's
// output keep working even if that relay ever goes away.
import handler from './api/relay.js';
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const enc = (s) => encodeURIComponent(s);
// Cache-busted imports target the shared core handler directly, so env-var
// changes actually reload it (the api/ wrapper's own import would stay cached).
const MOD_URL = pathToFileURL(new URL('./lib/relay.js', import.meta.url).pathname).href;

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

function makeRes() {
  const state = { statusCode: 200, headers: {}, body: null, ended: false };
  const res = {
    setHeader(k, v) { state.headers[k.toLowerCase()] = v; },
    getHeader(k) { return state.headers[k.toLowerCase()]; },
    getHeaders() { return { ...state.headers }; },
    status(code) { state.statusCode = code; return this; },
    json(obj) {
      state.headers['content-type'] = 'application/json';
      state.body = JSON.stringify(obj);
      state.ended = true;
      return this;
    },
    send(body) {
      state.body = body;
      state.ended = true;
      return this;
    },
    end(body) {
      if (body !== undefined) state.body = body;
      state.ended = true;
      return this;
    },
  };
  return { res, state };
}

async function callHandler(fn, method, url, reqHeaders = {}) {
  const u = new URL(url, 'http://test.local');
  const { res, state } = makeRes();
  const req = {
    method,
    query: Object.fromEntries(u.searchParams.entries()),
    headers: { host: 'my-relay.example.com', ...reqHeaders },
  };
  await fn(req, res);
  return state;
}
const call = (method, url, h) => callHandler(handler, method, url, h);

// ---- fixtures ---------------------------------------------------------------
const FIXTURES = 'test-fixtures';
fs.mkdirSync(FIXTURES, { recursive: true });
async function fixture(name, url) {
  const p = `${FIXTURES}/${name}`;
  if (!fs.existsSync(p)) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
  }
  return fs.readFileSync(p);
}

// 1. HTML page — full pipeline: attribute rewrites + script injection
{
  const s = await call('GET', `http://x/api/relay?url=${enc('https://core-logic-utils.github.io/tabspace.html')}`);
  check('html: 200', s.statusCode === 200);
  check('html: content-type passthrough', (s.headers['content-type'] || '').includes('text/html'));
  check('html: cache-control 60s', s.headers['cache-control'] === 'public, max-age=60');
  const body = s.body.toString();
  const headAt = body.indexOf('<head>');
  check('html: script right after <head>', body.slice(headAt + 6, headAt + 8) === '\n\n');
  fs.writeFileSync('/tmp/my_tabspace_full.html', body);

  // local origin derives http:// (no x-forwarded-proto on a plain local request)
  check('html: http origin locally', body.includes("const proxyBase = 'http://my-relay.example.com/api/relay?url='"));

  // with x-forwarded-proto (as on Vercel) the origin is https
  const s2 = await call('GET', `http://x/api/relay?url=${enc('https://core-logic-utils.github.io/tabspace.html')}`, { 'x-forwarded-proto': 'https' });
  check('html: https origin behind proxy header', s2.body.toString().includes("const proxyBase = 'https://my-relay.example.com/api/relay?url='"));

  // BYTE-IDENTICAL comparison with the original relay's output
  const orig = (await fixture('original_relay_tabspace.html',
    'https://logistical-utilities.vercel.app/api/relay?url=' + enc('https://core-logic-utils.github.io/tabspace.html'))).toString();
  const norm = (t) => t.replaceAll('https://logistical-utilities.vercel.app', 'https://NORMHOST');
  const mine = body.replaceAll('http://my-relay.example.com', 'https://NORMHOST');
  const identical = norm(orig) === mine;
  check('html: FULL output byte-identical to original relay', identical,
    identical ? '' : `\n${diffSnippet(norm(orig), mine).join('\n').slice(0, 2000)}`);
}

// 2. missing url
{
  const s = await call('GET', 'http://x/api/relay');
  check('missing url: 400', s.statusCode === 400);
  check('missing url: message', s.body === '{"error":"Missing \\"url\\" query parameter"}', s.body);
  check('missing url: CORS header', s.headers['access-control-allow-origin'] === '*');
}

// 3. open mode: third-party host allowed (matches original)
{
  const s = await call('GET', `http://x/api/relay?url=${enc('https://httpbin.org/html')}`);
  check('open mode: any host allowed', s.statusCode === 200);
}

// 4. OPTIONS preflight
{
  const s = await call('OPTIONS', 'http://x/api/relay?url=x');
  check('preflight: 204', s.statusCode === 204);
  check('preflight: max-age', s.headers['access-control-max-age'] === '86400');
  check('preflight: methods', s.headers['access-control-allow-methods'] === 'GET, OPTIONS');
}

// 5. upstream 404 passthrough
{
  const s = await call('GET', `http://x/api/relay?url=${enc('https://core-logic-utils.github.io/nope.html')}`);
  check('upstream 404: status passed through', s.statusCode === 404);
}

// 6. data: URL without <head> — prepend
{
  const s = await call('GET', `http://x/api/relay?url=${enc('data:text/html,<body>nohead</body>')}`);
  check('data url: 200', s.statusCode === 200);
  check('data url: script prepended', s.body.toString().startsWith('\n\n      <script>'));
  check('data url: original body after script', s.body.toString().endsWith('<body>nohead</body>'));
}

// 7. binary passthrough
{
  const s = await call('GET', `http://x/api/relay?url=${enc('https://core-logic-utils.github.io/assets/tabspacelogo.png')}`);
  const direct = await fixture('direct_logo.png', 'https://core-logic-utils.github.io/assets/tabspacelogo.png');
  check('png: content-type', (s.headers['content-type'] || '').includes('image/png'));
  check('png: byte-identical passthrough', Buffer.compare(Buffer.from(s.body), direct) === 0);
}

// 8. CSS url() rewrite (third-party CDN, open mode)
{
  const s = await call('GET', `http://x/api/relay?url=${enc('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css')}`);
  const body = s.body.toString();
  check('css: 200', s.statusCode === 200);
  check('css: contains rewritten url', body.includes("url(http://my-relay.example.com/api/relay?url=https%3A%2F%2Fcdnjs.cloudflare.com%2Fajax%2Flibs%2Ffont-awesome%2F6.5.1%2Fwebfonts%2Ffa-brands-400.woff2)"));
  check('css: no raw relative urls left', !body.includes('url(../webfonts'));
}

// 9. redirects followed server-side
{
  const s = await call('GET', `http://x/api/relay?url=${enc('https://github.io')}`);
  check('redirect: 200 after follow', s.statusCode === 200);
}

// 10. invalid scheme
{
  const s = await call('GET', `http://x/api/relay?url=${enc('file:///etc/passwd')}`);
  check('file scheme: rejected', s.statusCode === 400);
  check('file scheme: no body leak', !String(s.body).includes('root:'));
}

// 11. CORS on normal responses
{
  const s = await call('GET', `http://x/api/relay?url=${enc('https://core-logic-utils.github.io/tabspace.html')}`);
  check('cors: origin *', s.headers['access-control-allow-origin'] === '*');
  check('cors: headers *', s.headers['access-control-allow-headers'] === '*');
}

// 12. HEAD request
{
  const s = await call('HEAD', `http://x/api/relay?url=${enc('https://core-logic-utils.github.io/tabspace.html')}`);
  check('HEAD: 200', s.statusCode === 200);
}

// 13. HTML attribute rewriting rules (vs original relay behavior)
{
  const test = `<html><head></head><body><a href="https://example.com/x">abs</a><a href="mailto:a@b.c">mail</a><img src="pic.png"><form action="/submit"><input type="image" src="btn.png"><div style="background:url(bg.png)">bg</div><iframe src="https://example.com/f"></iframe><link rel="icon" href="data:,"></body></html>`;
  const s = await call('GET', `http://x/api/relay?url=${enc('data:text/html,' + test)}`);
  const body = s.body.toString().slice(s.body.toString().indexOf('</script>') + 9);
  const PB = 'http://my-relay.example.com/api/relay?url=';
  check('attrs: absolute a href rewritten', body.includes(`<a href="${PB}${encodeURIComponent('https://example.com/x')}">abs</a>`));
  check('attrs: mailto rewritten (original quirk)', body.includes(`<a href="${PB}${encodeURIComponent('mailto:a@b.c')}">mail</a>`));
  check('attrs: relative img src NOT rewritten', body.includes('<img src="pic.png">'));
  check('attrs: form action NOT rewritten', body.includes('action="/submit"'));
  check('attrs: inline style NOT rewritten', body.includes('background:url(bg.png)'));
  check('attrs: iframe src rewritten', body.includes(`<iframe src="${PB}${encodeURIComponent('https://example.com/f')}"></iframe>`));
  check('attrs: data: href NOT rewritten', body.includes('href="data:,"'));

  // compare against the ORIGINAL relay's output for the same page (fixture-cached)
  const origOut = (await fixture('original_relay_attrs.html',
    'https://logistical-utilities.vercel.app/api/relay?url=' + enc('data:text/html,' + test))).toString();
  const origBody = origOut.slice(origOut.indexOf('</script>') + 9);
  const norm = (t) => t.replaceAll('https://logistical-utilities.vercel.app', 'https://NORMHOST');
  const mineN = body.replaceAll('http://my-relay.example.com', 'https://NORMHOST');
  check('attrs: rewritten body byte-identical to original relay', norm(origBody) === mineN,
    `\norig: ${JSON.stringify(norm(origBody).slice(0, 400))}\nmine: ${JSON.stringify(mineN.slice(0, 400))}`);
}

// 14. script-injection safety: hostile target URL cannot break the injected script
{
  const hostile = `data:text/html,<body>ok</body><script>var x = '</scr` + `ipt>';</scr` + `ipt>`;
  const s = await call('GET', `http://x/api/relay?url=${enc(hostile)}`);
  const body = s.body.toString();
  // the emitted targetBase literal must JS-unescape back to the exact target URL
  const m = body.match(/const targetBase = '((?:\\.|[^'\\])*)';/);
  check('breakout: targetBase literal present', !!m);
  if (m) {
    const decoded = eval(`'${m[1]}'`); // JS-unescape the literal we emitted
    check('breakout: targetBase round-trips exactly', decoded === hostile,
      `\ndecoded: ${JSON.stringify(decoded)}\nhostile: ${JSON.stringify(hostile)}`);
    check('breakout: no raw </script> inside the literal', !m[1].includes('</script>'));
  }
  // the injected script must still be syntactically intact: its own closer is
  // the FIRST </script> in the document, and it appears after the IIFE end
  const firstClose = body.indexOf('</script>');
  check('breakout: injected script closer is first', body.slice(firstClose - 20, firstClose).includes('})()'));
}

// 15. allowlist mode: disallowed redirect destination is blocked (fresh module with env)
{
  // local redirect upstream on an ALLOWED host, redirecting to allowed/disallowed targets
  const redirector = http.createServer((rq, rs) => {
    if (rq.url === '/to-disallowed') {
      rs.writeHead(302, { Location: 'https://example.com/' });
      return rs.end();
    }
    if (rq.url === '/to-allowed') {
      rs.writeHead(302, { Location: '/final' });
      return rs.end();
    }
    rs.writeHead(200, { 'Content-Type': 'text/html' });
    rs.end('<html><head></head><body>final</body></html>');
  });
  await new Promise((r) => redirector.listen(3128, '127.0.0.1', r));

  process.env.RELAY_ALLOWED_HOSTS = '127.0.0.1,localhost';
  const mod = await import(`${MOD_URL}?allowlist`);
  const s = await callHandler(mod.default, 'GET', `http://x/api/relay?url=${enc('http://127.0.0.1:3128/to-disallowed')}`);
  check('allowlist: disallowed redirect blocked with 403', s.statusCode === 403, `got ${s.statusCode}: ${s.body}`);
  check('allowlist: correct error message', s.body === '{"error":"Redirect target is not allowed"}', s.body);
  // allowed redirect still works (relative Location resolved and followed)
  const s2 = await callHandler(mod.default, 'GET', `http://x/api/relay?url=${enc('http://127.0.0.1:3128/to-allowed')}`);
  check('allowlist: allowed redirect follows', s2.statusCode === 200 && s2.body.toString().includes('final'));
  delete process.env.RELAY_ALLOWED_HOSTS;
  redirector.close();
}

// 16. upstream timeout covers the body read (fresh module with 700ms timeout)
{
  // local slow upstream: sends headers instantly, body after 3s
  const slow = http.createServer((rq, rs) => {
    rs.writeHead(200, { 'Content-Type': 'text/html' });
    rs.flushHeaders(); // force headers out immediately; body arrives 3s later
    setTimeout(() => rs.end('<html><head></head><body>slow</body></html>'), 3000);
  });
  await new Promise((r) => slow.listen(3127, '127.0.0.1', r));

  process.env.RELAY_TIMEOUT_MS = '700';
  const mod = await import(`${MOD_URL}?timeout`);
  const t0 = Date.now();
  const s = await callHandler(mod.default, 'GET', 'http://x/api/relay?url=http%3A%2F%2F127.0.0.1%3A3127%2Fslow');
  const elapsed = Date.now() - t0;
  check('timeout: stalled body aborted with 500', s.statusCode === 500, `got ${s.statusCode}`);
  check('timeout: fails fast (body read covered)', elapsed < 2500, `took ${elapsed}ms`);
  check('timeout: correct error message', s.body === '{"error":"Failed to fetch the target URL"}', s.body);
  delete process.env.RELAY_TIMEOUT_MS;
  slow.close();
}

function diffSnippet(a, b) {
  const lines = [];
  const al = a.split('\n'), bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      lines.push(`orig[${i}]: ${JSON.stringify(al[i])}`);
      lines.push(`mine[${i}]: ${JSON.stringify(bl[i])}`);
    }
  }
  return lines;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
