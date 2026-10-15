# Deploying the Bueno Sports site

Pure static files — no build step, no backend, no API keys. The one
infrastructure requirement: the NHL API doesn't send CORS headers, so the
site calls it through a same-origin `/nhl-api/*` proxy path. Each host below
rewrites that path to `https://api-web.nhle.com/v1/*` with a one-file rule.

## Netlify (recommended)

1. Push this folder to a GitHub repo.
2. Netlify → Add new site → Import from Git. Build command: *(empty)*.
   Publish directory: the repo root (or the folder, if it's a subdir).
3. `netlify.toml` (already included) sets up the `/nhl-api/*` proxy rewrite.
4. Deploy. Done — `https://<your-site>.netlify.app`.

## Vercel

Add a `vercel.json` at the repo root:

```json
{
  "rewrites": [{ "source": "/nhl-api/:path*", "destination": "https://api-web.nhle.com/v1/:path*" }]
}
```

Then import the repo in Vercel with no build command.

## Cloudflare Pages

Add a `_redirects` file at the repo root:

```
/nhl-api/*  https://api-web.nhle.com/v1/:splat  200
```

Then connect the repo in Cloudflare Pages (no build command).

## Local development

Any static server works, but the `/nhl-api` path needs proxying. Quick hack:

```bash
# terminal 1: proxy the NHL API to localhost:8902
python3 - <<'EOF'
from http.server import BaseHTTPRequestHandler, HTTPServer
import urllib.request
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        req = urllib.request.Request('https://api-web.nhle.com' + self.path,
            headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', 8902), H).serve_forever()
EOF
# terminal 2: serve the site, rewriting /nhl-api to the proxy is unnecessary —
# instead open with ?api= override:
python3 -m http.server 8901 --directory ~/workspace/nhl-goal-model-site
# open http://localhost:8901/?api=http://127.0.0.1:8902
```

(The `?api=` query override exists for exactly this — it bypasses the
`/nhl-api` proxy path. The local proxy above adds `Access-Control-Allow-Origin`
so the browser accepts the responses.)
