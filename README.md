# website-inliner

A web service that fetches a URL and inlines all its external **scripts** (`<script src>`) and **stylesheets** (`<link rel="stylesheet">`, `@import`, inline `style` attributes with `url()`) into a single self-contained HTML file.

## Features

- **Script inlining** — downloads external JS and embeds it inline
- **Stylesheet inlining** — downloads external CSS, resolves `url()` references, and inlines `@import` rules recursively
- **Concurrent fetching** — multiple resources fetched in parallel with configurable concurrency
- **Caching** — in-memory cache to avoid re-downloading the same resource
- **Selective inlining** — choose to inline only scripts, only styles, or both

## Usage

### API

```
POST /inline
Content-Type: application/json

{
  "url": "https://example.com",
  "scripts": true,
  "styles": true
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

Environment variables:

| Variable        | Default  | Description               |
| --------------- | -------- | ------------------------- |
| `PORT`          | `3000`   | Server port               |
| `TIMEOUT`       | `15000`  | Request timeout (ms)      |
| `CACHE_TTL`     | `300000` | Cache lifetime (ms)       |
| `MAX_CONCURRENCY` | `10`   | Max parallel fetches      |

## License

MIT
