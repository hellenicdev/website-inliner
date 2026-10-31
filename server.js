const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const urlLib = require("url");
const { rateLimit } = require("express-rate-limit");
const { LRUCache } = require("lru-cache");
const {
  RequestFilteringHttpAgent,
  RequestFilteringHttpsAgent,
} = require("request-filtering-agent");

function envInt(name, fallback, min = 1) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) return fallback;
  return value;
}

const app = express();

// Render injects RENDER=true and sits one hop in front of the app. A hop count
// (not `true`) keeps clients from spoofing X-Forwarded-For when they connect directly.
const trustProxyHops = envInt("TRUST_PROXY_HOPS", process.env.RENDER ? 1 : 0, 0);
if (trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
}

const ALLOWED_ORIGINS = (() => {
  const raw = process.env.CORS_ORIGIN?.trim();
  const origins = (raw || "https://hellenicdev.eu")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : ["https://hellenicdev.eu"];
})();

app.use(
  cors({
    origin(origin, callback) {
      if (origin && ALLOWED_ORIGINS.includes(origin)) {
        callback(null, origin);
        return;
      }
      callback(null, false);
    },
  }),
);

app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 3000;
const TIMEOUT = envInt("TIMEOUT", 15000);
const CACHE_TTL = envInt("CACHE_TTL", 300000);
const MAX_CONCURRENCY = envInt("MAX_CONCURRENCY", 10);
const MAX_IMAGE_SIZE = envInt("MAX_IMAGE_SIZE", 5) * 1024 * 1024;
const CACHE_MAX_ENTRIES = envInt("CACHE_MAX_ENTRIES", 500);
const CACHE_MAX_BYTES = envInt("CACHE_MAX_BYTES", 32 * 1024 * 1024);
const RATE_LIMIT_WINDOW_MS = envInt("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000);
const RATE_LIMIT_MAX = envInt("RATE_LIMIT_MAX", 30);
const MAX_REDIRECTS = 5;

const inlineLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  limit: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  // Hop count is chosen explicitly above. Don't fail the request when a
  // client sends X-Forwarded-For while trust proxy is off.
  validate: { xForwardedForHeader: false },
});

function createCache(sizeCalculation) {
  return new LRUCache({
    max: CACHE_MAX_ENTRIES,
    ttl: CACHE_TTL,
    maxSize: CACHE_MAX_BYTES,
    sizeCalculation,
  });
}

const textCache = createCache((value) => Math.max(1, Buffer.byteLength(value)));
const binCache = createCache((value) =>
  Math.max(1, value.buf.length + Buffer.byteLength(value.mime || "")),
);

function cached(map, url) {
  if (!map.has(url)) return null;
  return map.get(url);
}

function store(map, url, data) {
  map.set(url, data);
}

class HttpError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

function assertAllowedUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError("Invalid URL", 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError("Only http and https URLs are allowed", 400);
  }
  if (!parsed.hostname) {
    throw new HttpError("Invalid URL", 400);
  }
  return parsed;
}

function toFetchError(err) {
  if (err instanceof HttpError) return err;
  const detail = [err?.message, err?.cause?.message].filter(Boolean).join(" ") || "Request failed";
  if (/is not allowed|private IP address|meta IP address/i.test(detail)) {
    return new HttpError("URL is not allowed", 400);
  }
  return new HttpError(detail, 502);
}

// Both agents are set so a cross-protocol redirect cannot skip the filter.
// Each connection resolves DNS and rejects private, loopback, link-local, and other non-unicast addresses.
const httpAgent = new RequestFilteringHttpAgent();
const httpsAgent = new RequestFilteringHttpsAgent();

const httpOptions = {
  timeout: TIMEOUT,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; WebsiteInliner/1.0)",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
  httpAgent,
  httpsAgent,
  maxRedirects: 0,
  proxy: false,
  responseType: "text",
  transitional: { clarifyTimeoutError: true },
};

const http = axios.create(httpOptions);

const httpBin = axios.create({
  ...httpOptions,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; WebsiteInliner/1.0)" },
  responseType: "arraybuffer",
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function guardedGet(client, startUrl) {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedUrl(current);
    let response;
    try {
      response = await client.get(current, {
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 600,
      });
    } catch (err) {
      throw toFetchError(err);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.location;
      if (!location || !REDIRECT_STATUSES.has(response.status)) {
        throw new HttpError(`Request failed with status code ${response.status}`, 502);
      }
      if (hop === MAX_REDIRECTS) {
        throw new HttpError("Too many redirects", 502);
      }
      try {
        current = new URL(location, current).href;
      } catch {
        throw new HttpError("Invalid redirect URL", 400);
      }
      continue;
    }

    if (response.status >= 400) {
      throw new HttpError(`Request failed with status code ${response.status}`, 502);
    }
    return response;
  }
  throw new HttpError("Too many redirects", 502);
}

async function fetchText(url) {
  const hit = cached(textCache, url);
  if (hit !== null) return hit;
  const res = await guardedGet(http, url);
  const data = typeof res.data === "string" ? res.data : String(res.data ?? "");
  store(textCache, url, data);
  return data;
}

async function fetchBinary(url) {
  const hit = cached(binCache, url);
  if (hit !== null) return hit;
  const res = await guardedGet(httpBin, url);
  const buf = Buffer.from(res.data);
  if (buf.length > MAX_IMAGE_SIZE) {
    throw new Error(`Image too large (${buf.length} bytes)`);
  }
  const mime = res.headers["content-type"]?.split(";")[0] || "application/octet-stream";
  const result = { buf, mime };
  store(binCache, url, result);
  return result;
}

async function asyncMapLimit(array, fn, limit) {
  const results = [];
  const iterator = array.entries();

  async function worker() {
    for (const [i, item] of iterator) {
      results[i] = await fn(item, i);
    }
  }

  const workers = Array(Math.min(limit, array.length))
    .fill(null)
    .map(() => worker());
  await Promise.all(workers);
  return results;
}

function resolveUrl(base, path) {
  path = path.trim();
  if (!path || path.startsWith("data:") || path.startsWith("#") || path.startsWith("//")) {
    return path;
  }
  return urlLib.resolve(base, path);
}

function resolveCssUrls(css, baseUrl) {
  return css.replace(
    /url\(\s*(['"]?)((?:[^'")\s]|\\[^])*?)\1\s*\)/g,
    (match, quote, path) => {
      path = path.trim();
      if (!path || path.startsWith("data:") || path.startsWith("#")) return match;
      try {
        return `url(${quote}${urlLib.resolve(baseUrl, path)}${quote})`;
      } catch {
        return match;
      }
    },
  );
}

async function inlineCssImages(css, baseUrl) {
  const urlRegex = /url\(\s*(['"]?)((?:[^'")\s]|\\[^])*?)\1\s*\)/g;
  const replacements = [];
  let match;

  while ((match = urlRegex.exec(css)) !== null) {
    const quote = match[1];
    const raw = match[0];
    const index = match.index;
    let path = match[2].trim();
    if (!path || path.startsWith("data:") || path.startsWith("#")) continue;

    const fullUrl = urlLib.resolve(baseUrl, path);
    replacements.push({
      idx: index,
      len: raw.length,
      promise: (async () => {
        try {
          const { buf, mime } = await fetchBinary(fullUrl);
          return `url(${quote}data:${mime};base64,${buf.toString("base64")}${quote})`;
        } catch {
          return raw;
        }
      })(),
    });
  }

  if (replacements.length === 0) return css;

  await Promise.all(replacements.map((r) => r.promise));
  replacements.sort((a, b) => b.idx - a.idx);

  let result = css;
  for (const { idx, len, promise } of replacements) {
    result = result.slice(0, idx) + (await promise) + result.slice(idx + len);
  }
  return result;
}

async function inlineImports(css, baseUrl, inlineImages) {
  const IMPORT_RE =
    /@import\s+(?:url\(\s*['"]?([^'")\s]+)['"]?\s*\)|['"]([^'"]+)['"])\s*;?/g;
  let result = css;
  let match;

  while ((match = IMPORT_RE.exec(css)) !== null) {
    const importPath = match[1] || match[2];
    if (!importPath) continue;

    try {
      const fullUrl = urlLib.resolve(baseUrl, importPath);
      let imported = await fetchText(fullUrl);
      imported = resolveCssUrls(imported, fullUrl);
      imported = await inlineImports(imported, fullUrl, inlineImages);
      if (inlineImages) {
        imported = await inlineCssImages(imported, fullUrl);
      }
      result = result.replace(match[0], imported);
    } catch (err) {
      console.log(`@import failed: ${importPath}`);
    }
  }

  return result;
}

function toDataUri(url) {
  return (async () => {
    try {
      const { buf, mime } = await fetchBinary(url);
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      return url;
    }
  })();
}

app.post("/inline", inlineLimiter, async (req, res) => {
  const { url: rawUrl, scripts = true, styles = true, images = false } = req.body || {};
  const url = typeof rawUrl === "string" ? rawUrl.trim() : "";

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  try {
    assertAllowedUrl(url);
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    if (scripts) {
      const scriptTags = [];
      $("script[src]").each((_, el) => {
        scriptTags.push({ el: $(el), src: $(el).attr("src") });
      });

      await asyncMapLimit(
        scriptTags,
        async ({ el, src }) => {
          if (!src) return;
          if (src.startsWith("//")) src = "https:" + src;
          const fullUrl = urlLib.resolve(url, src);
          try {
            const js = await fetchText(fullUrl);
            el.replaceWith(`<script>${js}</script>`);
          } catch (err) {
            console.log(`Script failed: ${fullUrl}`);
          }
        },
        MAX_CONCURRENCY,
      );
    }

    if (images) {
      const imgTasks = [];

      $("img[src]").each((_, el) => {
        const current = $(el).attr("src");
        if (!current || current.startsWith("data:")) return;
        const fullUrl = urlLib.resolve(url, current);
        imgTasks.push(
          toDataUri(fullUrl).then((uri) => $(el).attr("src", uri)),
        );
      });

      $("source[srcset]").each((_, el) => {
        const srcset = $(el).attr("srcset");
        if (!srcset) return;
        const entries = srcset.split(",").map((e) => e.trim()).filter(Boolean);
        const resolved = entries.map((entry) => {
          const parts = entry.split(/\s+/);
          const src = parts[0];
          const desc = parts.slice(1).join(" ");
          if (!src || src.startsWith("data:")) return Promise.resolve(entry);
          const fullUrl = urlLib.resolve(url, src);
          return toDataUri(fullUrl).then((uri) => (desc ? `${uri} ${desc}` : uri));
        });
        imgTasks.push(
          Promise.all(resolved).then((uris) => $(el).attr("srcset", uris.join(", "))),
        );
      });

      $("video[poster]").each((_, el) => {
        const current = $(el).attr("poster");
        if (!current || current.startsWith("data:")) return;
        const fullUrl = urlLib.resolve(url, current);
        imgTasks.push(toDataUri(fullUrl).then((uri) => $(el).attr("poster", uri)));
      });

      $("link[rel*='icon'], link[rel*='apple-touch']").each((_, el) => {
        const current = $(el).attr("href");
        if (!current || current.startsWith("data:")) return;
        const fullUrl = urlLib.resolve(url, current);
        imgTasks.push(toDataUri(fullUrl).then((uri) => $(el).attr("href", uri)));
      });

      $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
        const current = $(el).attr("content");
        if (!current || current.startsWith("data:")) return;
        const fullUrl = urlLib.resolve(url, current);
        imgTasks.push(toDataUri(fullUrl).then((uri) => $(el).attr("content", uri)));
      });

      await Promise.all(imgTasks);
    }

    if (styles) {
      const cssTasks = [];

      $('link[rel="stylesheet"]').each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        cssTasks.push(
          (async () => {
            const fullUrl = urlLib.resolve(url, href);
            try {
              let css = await fetchText(fullUrl);
              css = resolveCssUrls(css, fullUrl);
              css = await inlineImports(css, fullUrl, images);
              if (images) {
                css = await inlineCssImages(css, fullUrl);
              }
              $(el).replaceWith(`<style>${css}</style>`);
            } catch (err) {
              console.log(`Stylesheet failed: ${fullUrl}`);
            }
          })(),
        );
      });

      $("style").each((_, el) => {
        const content = $(el).html();
        if (!content || !content.includes("@import")) return;
        cssTasks.push(
          (async () => {
            try {
              let resolved = await inlineImports(content, url, images);
              if (images) {
                resolved = await inlineCssImages(resolved, url);
              }
              $(el).html(resolved);
            } catch (err) {
              console.log("Style @import resolution failed");
            }
          })(),
        );
      });

      if (images) {
        $("[style]").each((_, el) => {
          const style = $(el).attr("style");
          if (!style || !style.includes("url(")) return;
          cssTasks.push(
            (async () => {
              const resolved = resolveCssUrls(style, url);
              const inlined = await inlineCssImages(resolved, url);
              $(el).attr("style", inlined);
            })(),
          );
        });
      } else {
        $("[style]").each((_, el) => {
          const style = $(el).attr("style");
          if (style && style.includes("url(")) {
            $(el).attr("style", resolveCssUrls(style, url));
          }
        });
      }

      await Promise.all(cssTasks);
    }

    res.json({ html: $.html() });
  } catch (err) {
    const error = toFetchError(err);
    console.error("Error:", err.message);
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.too.large" || err.status === 413 || err.statusCode === 413) {
    return res.status(413).json({ error: "Request body too large" });
  }
  if (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400)) {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  console.error("Error:", err.message);
  res.status(500).json({ error: "Request failed" });
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
}

module.exports = { app, textCache, binCache };
