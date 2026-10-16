// Cloudflare Pages Function: /nhl-api/* proxy.
//
// Replicates the netlify.toml rewrite:
//   /nhl-api/*  ->  https://api-web.nhle.com/v1/:splat   (status 200)
//
// The NHL API (api-web.nhle.com) sends no CORS headers, so browsers refuse
// direct cross-origin fetch() calls. This function proxies the API through the
// same origin, which the browser happily allows. The NHL API needs no key,
// so this function carries no secrets.

const UPSTREAM = 'https://api-web.nhle.com/v1';

export async function onRequest(context) {
  const { request, params } = context;

  // The site only reads — refuse anything that isn't a safe read.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // [[path]] catch-all gives the splat segments as an array.
  const segments = Array.isArray(params.path) ? params.path : [];
  const path = segments.filter(Boolean).join('/');

  const incoming = new URL(request.url);
  const upstreamUrl = `${UPSTREAM}/${path}${incoming.search}`;

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: request.method,
      headers: {
        'User-Agent': 'BuenoSports/1.0 (NHL stats proxy)',
        Accept: 'application/json',
      },
    });
  } catch (err) {
    // Upstream unreachable — generic 502, no internals leaked.
    return new Response('Upstream unavailable', { status: 502 });
  }

  // Pass through status + body; forward only safe headers. We set our own
  // short cache so a popular slate doesn't hammer the upstream on every hit.
  const headers = new Headers();
  const contentType = upstreamResp.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('cache-control', 'public, max-age=60');

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    headers,
  });
}
