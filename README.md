# website-inliner
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/S6S31XB030)

A web service that fetches a URL and inlines all its external **scripts** (`<script src>`) and **stylesheets** (`<link rel="stylesheet">`, `@import`, inline `style` attributes with `url()`) into a single self-contained HTML file.

## Features

- **Script inlining** — downloads external JS and embeds it inline
- **Stylesheet inlining** — downloads external CSS, resolves `url()` references, and inlines `@import` rules recursively
- **Image inlining** — converts `<img>`, `<source srcset>`, `<video poster>`, favicons, Open Graph images, and CSS `url()` references to inline data URIs
- **Concurrent fetching** — multiple resources fetched in parallel with configurable concurrency
- **Caching** — size-capped in-memory LRU cache to avoid re-downloading the same resource
- **Selective inlining** — choose to inline only scripts, styles, images, or any combination
- **SSRF protection** — only `http` and `https` URLs are fetched. Every document, sub-resource, and redirect hop is checked by `request-filtering-agent`, which resolves DNS and blocks private, loopback, link-local, and other non-public addresses
- **Rate limiting** — `POST /inline` is limited per client IP

## Usage

### API

```
POST /inline
Content-Type: application/json

{
  "url": "https://example.com",
  "scripts": true,
  "styles": true,
  "images": false
}
```

Returns:

```json
{
  "html": "<!DOCTYPE html>..."
}
```

### Web UI

Open `index.html` in a browser, enter a URL, and click **Inline**.

### Self-host

```bash
npm install
npm start
# or
npm run dev
```

`POST /inline` accepts a JSON body of about 10 KB. Requests for private or non-HTTP URLs are rejected.

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Server port |
| `TIMEOUT` | `15000` | Request timeout (ms) |
| `CACHE_TTL` | `300000` | Cache lifetime (ms) |
| `CACHE_MAX_ENTRIES` | `500` | Max entries in each of the text and binary caches |
| `CACHE_MAX_BYTES` | `33554432` | Max total bytes in each cache (32 MiB) |
| `MAX_CONCURRENCY` | `10` | Max parallel fetches |
| `MAX_IMAGE_SIZE` | `5` | Max image size in MB |
| `CORS_ORIGIN` | `https://hellenicdev.eu` | Browser origins allowed to call the API. Separate multiple origins with commas. |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit window for `POST /inline` (ms) |
| `RATE_LIMIT_MAX` | `30` | Max `/inline` requests per IP per window |
| `TRUST_PROXY_HOPS` | `1` when `RENDER` is set, otherwise `0` | Reverse-proxy hops used to read the client IP. Set to `1` behind a single proxy. |

Node.js 20 or newer is required.

## License

MIT
