# MinTranslate Deployment

MinTranslate ships as **static assets only**: no application backend, no server
functions, no runtime API. Build once, then publish the output directory to any
static host, a CDN, or an intranet web server.

Two deployment shapes are supported from the same source:

- **Public single-user** — static host plus PWA install.
- **Intranet / air-gapped** — intranet HTTPS site plus a self-built model
  endpoint, with **zero external network dependency**.

---

## 1. Non-negotiable prerequisite: HTTPS

> **Installing as a PWA and using offline capability require HTTPS.**
> This is the first constraint of this deployment, not a recommendation.

A browser only registers a Service Worker in a **secure context**. Without it,
the application still loads and works, but it cannot be installed to the
desktop and cannot work offline — and it will say so in a banner.

| Address | Service Worker | PWA install |
| --- | --- | --- |
| `https://translate.corp.local` | yes | yes |
| `https://192.168.1.50` (self-signed cert) | yes, once the cert is trusted | yes |
| `http://localhost:3000` | yes (browser exemption) | yes |
| `http://192.168.1.50` (plain HTTP) | **no** | **no** |
| `http://translate.corp.local` (plain HTTP) | **no** | **no** |

When the application detects an insecure context it shows a persistent banner
explaining that installation and offline capability are unavailable. It does not
silently hide the install entry point.

### Three ways to reach HTTPS

**Path A — intranet CA (recommended).** Have your intranet CA issue a
certificate for the intranet hostname. Clients already trust the root, so there
is no warning and no per-client work.

- Prerequisite: an intranet CA that can issue for the chosen hostname.
- Failure mode: not used, the certificate is untrusted and Service Worker
  registration fails with no visible error beyond the console.

**Path B — self-signed certificate.** Works, but the certificate must be
imported and trusted on **every** client machine.

- Prerequisite: ability to distribute and trust the certificate on each client.
- Failure mode: a client without the certificate gets a trust warning, and
  Service Worker registration fails until it is trusted.

**Path C — Chrome policy exemption (controlled environments only).** Mark the
origin as secure through the `UnsafelyTreatInsecureOriginAsSecure` enterprise
policy, or launch the browser with
`--unsafely-treat-insecure-origin-as-secure=http://your-host`.

- Prerequisite: central management, or control over how the browser is
  launched. **This is a development and controlled-environment measure.**
  Without central management it is not a usable deployment.
- Failure mode: any client that does not receive the policy falls back to the
  plain-HTTP row of the table above.

---

## 2. Build

```bash
pnpm install
pnpm build
```

`pnpm build` does two things:

1. `vite build` — produces the static output **plus** a build-time-only
   intermediate bundle used to render the application shell. The intermediate
   lives outside the output directory and is never deployed.
2. `pnpm verify:no-external-refs` — scans the output and **fails the build** if
   it finds any reference to an external origin. This is what guarantees the
   application loads with no external network access.

### The output directory is the deployable artifact

Publish `dist/` as-is. It contains only static files:

```
dist/
  _shell.html            pre-rendered application shell
  assets/                JS, CSS
  manifest.webmanifest   web app manifest
  icon-192.png
  icon-512.png
  icon-512-maskable.png
  apple-touch-icon.png
  icon.svg
```

There is no server entry in `dist/`. Deployment never runs Node.js.

### Build-time configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_BASE_PATH` | `/` | Mount point. Use `/mintranslate/` for a sub-path deployment. |
| `VITE_GA_MEASUREMENT_ID` | *(empty)* | GA4 measurement ID. Empty means analytics is not loaded at all. |
| `VITE_GA_ENABLED` | `true` | Build-time analytics master switch. `false` disables analytics regardless of any measurement ID. |

See `.env.example` for the annotated list.

> **`VITE_` variables are embedded in the browser bundle and are readable by
> anyone who loads the application.** Never place an API key, token, password or
> database connection string in one.

`VITE_BASE_PATH` is normalized, so `mintranslate`, `/mintranslate` and
`/mintranslate/` all mean the same thing. The build prints the effective base
path as `[mintranslate] base path: ...` so it can be confirmed from build logs.

### Verifying the output before you publish

```bash
node scripts/check-external-refs.mjs dist          # no external references
node scripts/serve-static.mjs --dir dist --base /  # serve it the way a static host would
```

The static server implements the same two rules your host must be configured
with (see the next section), so a deep link can be checked locally.

---

## 3. Routing: serve the shell for unmatched paths

The application renders routes on the client. Any URL that is **not** a real
file must return the application shell, otherwise a deep link or a page refresh
returns `404`.

The two rules to configure:

1. If a matching file exists, serve it.
2. Otherwise, return `_shell.html` with a `200`.

The shell is named `_shell.html` rather than `index.html` on purpose: see design
decision D1. Platform examples follow.

**Nginx**

```nginx
location / {
  try_files $uri $uri/ /_shell.html;
}
```

**Apache** (`.htaccess` in the output directory)

```apache
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /_shell.html [L]
```

**Netlify** (`_redirects` copied into the output directory)

```
/*  /_shell.html  200
```

**Cloudflare Pages** (`_redirects`)

```
/*  /_shell.html  200
```

**GitHub Pages.** Pages supports a custom `404.html` only, so copy the shell:

```bash
cp dist/_shell.html dist/404.html
```

**Vercel** (`vercel.json`). Vercel serves the file if it exists, so only the
fallback needs declaring:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "pnpm build",
  "outputDirectory": "dist",
  "rewrites": [{ "source": "/(.*)", "destination": "/_shell.html" }]
}
```

> A platform whose fallback file **must** be named `/index.html` needs a build
> variant that emits the shell under that name. This is not enabled by default;
> rename or copy the shell in your deployment step if your platform requires it.

---

## 4. Sub-path deployment

To mount the application at `https://host/mintranslate/`:

```bash
VITE_BASE_PATH=/mintranslate/ pnpm build
```

Then publish `dist/` so it is served under `/mintranslate/`. Everything the
build emits — asset URLs, the router base path, the manifest reference, the
manifest's own `start_url` and `scope`, and icon URLs — is relative to that
prefix. No absolute reference to the site root is produced.

Confirm it:

```bash
node scripts/serve-static.mjs --dir dist --base /mintranslate/ --port 4173
# then open http://localhost:4173/mintranslate/ and refresh a deep link
```

The manifest uses relative URLs (`./`, `./icon-192.png`) so it resolves
correctly under any mount point without further configuration.

---

## 5. Intranet / air-gapped deployment

MinTranslate is designed to run with **no external network access**. Its only
outbound requests are to the model endpoint **the user configures**, and to an
analytics endpoint if — and only if — one was configured at build time.

### Checklist

1. **Do not set `VITE_GA_MEASUREMENT_ID`.** Leave it empty (the default). The
   build then contains no reference to any analytics endpoint.
2. Optionally set `VITE_GA_ENABLED=false` as a hard build-time guarantee that
   analytics stays off even if a runtime setting is changed later.
3. Build. `pnpm verify:no-external-refs` must pass — it fails the build on any
   external reference, so a passing build is the evidence that nothing points
   outside.
4. Serve over **HTTPS** (section 1) so installation and offline work.
5. Point users at their own intranet model endpoint in settings.

### Verifying "no external requests"

After loading the application in a browser, the network panel should show
requests to **the application's own origin only**. There is no request to any
font service, icon CDN, analytics endpoint or other third party.

If you cannot use a browser, the equivalent check is:

```bash
node scripts/check-external-refs.mjs dist   # scans HTML, CSS, JS, JSON
```

### Offline (no network at all)

The application shell and its assets load with no network. The interface uses the
system font stack and bundles its icons, so text renders immediately and no icon is
missing.

Offline caching of the shell is delivered by the service worker, which precaches
the shell and its assets on first visit. Nothing in the build needs an external
network to load.

---

## 6. Connection requirements for an intranet model

The model endpoint is contacted **directly by the browser**. MinTranslate provides
no reverse proxy, gateway or relay, so the model side must supply two things:

1. **HTTPS**, with a certificate the client trusts. A page served over HTTPS cannot
   call an `http://` endpoint — the browser blocks it as mixed content, before the
   request is sent.
2. **An origin allowlist** covering the address the application is served from. The
   endpoint is a different origin, so the browser sends a preflight request first.

Both are required. HTTPS alone still fails the origin check; an allowlist alone
still fails the mixed-content check.

If the model side cannot provide a trusted HTTPS endpoint **and** allow the
application's origin, this application **cannot** reach it. There is no middle
layer to work around that: no reverse proxy, no gateway, no relay is provided or
distributed, and the API key travels from the browser straight to the endpoint.

### Telling the four failure modes apart

The browser does not say why a cross-origin request failed — a refused origin, an
untrusted certificate and an unreachable host all arrive as
`TypeError: Failed to fetch`. The application therefore decides what it can before
sending, and states the rest as possibilities rather than conclusions:

| Situation | How it is reported |
| --- | --- |
| Page is HTTPS, endpoint is not | `mixed content`, decided **before** any request is sent |
| Origin not allowed, certificate untrusted, or host unreachable | one combined cause plus a checklist covering all three |
| Endpoint names a certificate problem in its error text | `certificate`, with certificate-specific steps |

The combined case is deliberate: asserting a specific cause there would be a guess,
and a wrong guess sends the deployer to the wrong side of the connection.

### Per-framework configuration

Allow the application's origin. Replace `https://app.internal` with the address you
actually serve the application from.

**Ollama**

```bash
# Comma-separated; no trailing slash. Wildcards are not supported here.
OLLAMA_ORIGINS=https://app.internal ollama serve
```

HTTPS is not provided by Ollama itself; terminate TLS in front of it (see the Nginx
example below) and point the application at the `https://` address.

**vLLM**

```bash
vllm serve <model> --allowed-origins '["https://app.internal"]'
```

`--allowed-origins` takes a JSON array. Add TLS termination in front of vLLM, or
pass `--ssl-keyfile` / `--ssl-certfile` to have it serve HTTPS directly.

**LM Studio**

In the server settings, enable **CORS** and add the application's origin to the
allowed list. Enable HTTPS in the same panel if you have a certificate, otherwise
terminate TLS in front of it.

**Nginx in front of any of the above**

```nginx
server {
    listen 443 ssl;
    server_name model.internal;

    ssl_certificate     /etc/ssl/certs/model.internal.crt;
    ssl_certificate_key /etc/ssl/private/model.internal.key;

    location / {
        add_header Access-Control-Allow-Origin  "https://app.internal" always;
        add_header Access-Control-Allow-Headers "authorization, content-type" always;
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;

        # The browser sends a preflight before the real request; answering it here
        # is what makes the endpoint reachable at all.
        if ($request_method = OPTIONS) {
            add_header Access-Control-Max-Age 86400;
            return 204;
        }

        proxy_pass http://127.0.0.1:11434;
    }
}
```

### Verifying the model side without a browser

Each command below inspects the two things the browser will check. Run them from
the machine that will use the application, replacing the two placeholders.

**1. Does the endpoint allow the application's origin?**

```bash
curl -sI -X OPTIONS https://model.internal/v1/chat/completions \
  -H 'Origin: https://app.internal' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  | grep -i '^access-control-allow'
```

Expected: `access-control-allow-origin` echoing `https://app.internal` (or `*`).
No output means the preflight would fail.

**2. Is the certificate trusted by this client?**

```bash
curl -sI https://model.internal/v1/models
```

Success means the certificate chain validated. `SSL certificate problem` means it
did not — check the CA, the hostname, and the expiry date. Add `-v` to see the
chain when diagnosing.

**3. Is the host reachable at all?**

```bash
curl -sI --max-time 5 https://model.internal/v1/models | head -1
```

No output, or a timeout, separates "unreachable" from "reachable but refusing",
which the browser cannot distinguish for you.

Add `-k` **only** to confirm a suspicion that the certificate is the problem. A
request made with `-k` proved something about connectivity, not about whether the
browser will accept the endpoint.

### Building for an air-gapped network

1. **Do not set `VITE_GA_MEASUREMENT_ID`.** Leave it empty. The build then contains
   no analytics reference.
2. Optionally set `VITE_GA_ENABLED=false` as a second, build-time guarantee.
3. Build and check the result:

   ```bash
   pnpm build
   ```

   `pnpm build` runs the external-reference gate. It fails on any resource the
   browser would load from another origin, so a passing build is the evidence that
   nothing is fetched from outside. It also reports third-party URL *strings* that
   are not fetched (documentation links inside bundled SDKs, default endpoint
   constants) — those are informational and do not fail the build.
4. Serve over HTTPS, so installation and offline caching work.
5. Point users at their own intranet endpoint in settings.

The script can be run on its own against any build output:

```bash
node scripts/check-external-refs.mjs dist
```

### What "no external requests" does and does not mean

After loading the application, the network panel shows requests to **the
application's own origin only**, plus whatever endpoint the user configured. There
is no request to a font service, an icon CDN, an analytics endpoint or any other
third party.

Two things the build does contain, and neither causes a request on its own:

- **Endpoint constants for the public providers** (for example `api.openai.com`) and
  the search-engine addresses used by the lookup action. These are data, reached
  only when a user configures that provider or clicks that action — which in an
  air-gapped network will simply fail.
- **Documentation links inside bundled provider SDKs.** They are strings in the
  bundle, never fetched.
