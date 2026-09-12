/**
 * Netlify Function: the same-origin `/api/*` provider proxies, serverless.
 *
 * Reuses the exact provider middlewares that the Vite dev server mounts
 * (`server/providers/local.js`) instead of rewriting them: the function hosts
 * the Connect-style handlers on a loopback HTTP server inside the function
 * instance and proxies each invocation through it. One implementation of every
 * upstream proxy (OpenSky, CelesTrak, Overpass, TomTom, FIRMS, CCTV, Radio
 * Browser, OpenAI, Google Places, OSRM routes, ...) serves both local dev and
 * Netlify hosting.
 *
 * Deliberate differences from `npm run dev` (see README "Deploy on Netlify"):
 *   - The POWER UP key panel (`/api/setup/*`) is NOT deployed. It writes the
 *     checkout's .env and admits loopback callers only — on a public host it
 *     would admit everyone, because every proxied request arrives via
 *     loopback. Set keys as Netlify environment variables instead.
 *   - `/api/ais-live` degrades to an honest empty/stale feed: AISStream needs
 *     one long-lived websocket per key, which a function instance cannot keep
 *     open between invocations. Run locally for the live vessel layer.
 *   - Long-lived media streams (CCTV MJPEG/HLS piping, if configured) are cut
 *     at the platform's synchronous function time limit; static frames work.
 *   - Disk caches (`.gev-cache/`) land in the instance tmpdir and reset when
 *     the instance is recycled, so cache hit rates and the TomTom daily-budget
 *     counter are per-instance and best-effort rather than durable.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

/**
 * Dev-server-only plugins that must never be exposed on a public host.
 * 'gev-key-setup' guards itself by admitting loopback clients, and behind this
 * proxy every request is loopback — so it is excluded outright.
 */
const DEV_ONLY_PLUGINS = new Set(['gev-key-setup']);

/** Mirrors DEFAULT_CCTV_SOURCE_FILE in server/providers/local.js. */
const CCTV_SOURCE_PACK = 'config/cctv_sources.austin.json';

/** Header carrying the real visitor IP across the loopback hop. */
const CLIENT_IP_HEADER = 'x-gev-client-ip';

/** Hop-by-hop headers that must not cross the loopback proxy. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

/** The checkout/bundle root as seen before boot() moves cwd to the tmpdir. */
const initialCwd = process.cwd();

/** @type {Promise<{port:number}>|null} One provider stack per instance. */
let bootPromise = null;

/**
 * Does `pathname` fall under Connect mount `route`?
 * Mirrors Connect's boundary rule: the character after the prefix must be a
 * path or extension separator, so '/api/opensky' never captures
 * '/api/opensky-track'.
 */
function matchesMount(pathname, route) {
  if (!route) return true;
  if (!pathname.toLowerCase().startsWith(route.toLowerCase())) return false;
  const boundary = pathname.charAt(route.length);
  return boundary === '' || boundary === '/' || boundary === '.';
}

/**
 * Minimal Connect-compatible middleware stack: `use(route, fn)` registration,
 * in-order dispatch, mount-prefix stripping, and `next()` fall-through. This
 * is the only Vite dev-server surface the provider plugins rely on.
 */
function createMountRouter() {
  /** @type {Array<{route:string, fn:Function}>} */
  const stack = [];

  function handle(req, res, done) {
    const originalUrl = req.url || '/';
    const queryStart = originalUrl.indexOf('?');
    const pathname =
      queryStart === -1 ? originalUrl : originalUrl.slice(0, queryStart);
    const search = queryStart === -1 ? '' : originalUrl.slice(queryStart);
    let index = 0;

    function next(error) {
      req.url = originalUrl;
      if (error) return done(error);
      const layer = stack[index++];
      if (!layer) return done();
      if (!matchesMount(pathname, layer.route)) return next();
      let rest = pathname.slice(layer.route.length);
      if (!rest.startsWith('/')) rest = `/${rest}`;
      req.url = rest + search;
      try {
        const result = layer.fn(req, res, next);
        // Middlewares here own their responses; a rejected async handler is a
        // bug surfaced as a 500, never silently dropped.
        if (result && typeof result.catch === 'function') result.catch(done);
      } catch (err) {
        done(err);
      }
    }

    next();
  }

  return {
    use(route, fn) {
      if (typeof route === 'function') stack.push({ route: '', fn: route });
      else stack.push({ route: route.replace(/\/+$/, ''), fn });
    },
    handle,
  };
}

/**
 * Build the provider stack once per function instance and park it behind a
 * loopback HTTP server, so the Connect middlewares run against real Node
 * req/res objects exactly as they do under the Vite dev server.
 */
async function boot() {
  // Function bundles run on a read-only filesystem, and the providers'
  // `.gev-cache/` disk caches key off process.cwd() at module load — so move
  // cwd to the writable tmpdir BEFORE the provider modules are imported.
  try {
    process.chdir(os.tmpdir());
  } catch {
    // Keep whatever cwd we have; every cache write degrades gracefully.
  }

  // The CCTV source pack resolves relative to the checkout in dev; the bundled
  // function ships it via netlify.toml `included_files` instead. Point the
  // existing env override at wherever the pack actually landed.
  if (!process.env.CCTV_SOURCES_FILE && !process.env.CCTV_SOURCES_JSON) {
    for (const base of [process.env.LAMBDA_TASK_ROOT, initialCwd]) {
      if (!base) continue;
      const candidate = path.join(base, CCTV_SOURCE_PACK);
      if (fs.existsSync(candidate)) {
        process.env.CCTV_SOURCES_FILE = candidate;
        break;
      }
    }
  }

  // Imported dynamically so the chdir above precedes module initialization.
  const { localProviderPlugins } =
    await import('../../server/providers/local.js');

  const middlewares = createMountRouter();
  // The only server surface these plugins touch is `middlewares` (plus an
  // optional-chained `httpServer` close hook, absent here by design).
  const viteServerFacade = { middlewares, httpServer: null };
  for (const plugin of localProviderPlugins()) {
    if (!plugin || DEV_ONLY_PLUGINS.has(plugin.name)) continue;
    plugin.configureServer?.(viteServerFacade);
  }

  const server = http.createServer((req, res) => {
    // Per-IP guards (opt-in rate limiters, the OSRM route limiter) read
    // req.socket.remoteAddress, which is always loopback here. Surface the
    // real visitor IP forwarded by the handler below.
    const clientIp = req.headers[CLIENT_IP_HEADER];
    if (clientIp) {
      const socket = req.socket;
      Object.defineProperty(req, 'socket', {
        configurable: true,
        value: new Proxy(socket, {
          get(target, prop) {
            if (prop === 'remoteAddress') return clientIp;
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      });
    }
    middlewares.handle(req, res, (error) => {
      if (error) console.error('[netlify/api] provider error:', error);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(error ? 500 : 404, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          error: error ? 'Provider error' : 'Unknown /api route',
        }),
      );
    });
  });

  // The instance freezes between invocations. Never close idle keep-alive
  // sockets server-side: a close racing a thawed client's reuse would surface
  // as spurious ECONNRESETs. The client side may recycle connections freely.
  server.keepAliveTimeout = 0;

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();
  return { port: server.address().port };
}

function ensureBoot() {
  if (!bootPromise) {
    bootPromise = boot().catch((error) => {
      bootPromise = null; // A failed boot must not poison the warm instance.
      throw error;
    });
  }
  return bootPromise;
}

export default async function handler(request, context) {
  const { port } = await ensureBoot();

  const requestUrl = new URL(request.url);
  // config.path routes /api/* here with the original pathname; normalize a
  // default-URL invocation (e.g. `netlify functions:invoke`) just in case.
  let pathname = requestUrl.pathname;
  const fnPrefix = '/.netlify/functions/api';
  if (pathname === fnPrefix || pathname.startsWith(`${fnPrefix}/`)) {
    pathname = pathname.slice(fnPrefix.length) || '/';
  }

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (key === 'host' || key === 'content-length' || HOP_BY_HOP.has(key)) {
      continue;
    }
    headers.append(key, value);
  }
  const clientIp =
    context?.ip || request.headers.get('x-nf-client-connection-ip') || '';
  if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);

  const method = request.method || 'GET';
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : Buffer.from(await request.arrayBuffer());

  const upstream = await fetch(
    `http://127.0.0.1:${port}${pathname}${requestUrl.search}`,
    { method, headers, body, redirect: 'manual' },
  );

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key)) return;
    responseHeaders.append(key, value);
  });

  const bodyless =
    upstream.status === 204 || upstream.status === 304 || method === 'HEAD';
  return new Response(bodyless ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const config = {
  // URLPattern wildcard: every /api/* request routes here, evaluated before
  // redirect rules — the SPA fallback in netlify.toml can never shadow it.
  path: '/api/*',
};
