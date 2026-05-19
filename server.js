const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const urlLib = require("url");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const TIMEOUT = parseInt(process.env.TIMEOUT || "15000");
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "300000");
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || "10");
const MAX_IMAGE_SIZE = parseInt(process.env.MAX_IMAGE_SIZE || "5") * 1024 * 1024;

const textCache = new Map();
const binCache = new Map();

function cached(map, url) {
  const entry = map.get(url);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  map.delete(url);
  return null;
}

function store(map, url, data) {
  map.set(url, { data, ts: Date.now() });
}

const http = axios.create({
  timeout: TIMEOUT,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; WebsiteInliner/1.0)",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
  maxRedirects: 5,
  responseType: "text",
  transitional: { clarifyTimeoutError: true },
});

const httpBin = axios.create({
  timeout: TIMEOUT,
  headers: { "User-Agent": "Mozilla/5.0 (compatible; WebsiteInliner/1.0)" },
  maxRedirects: 5,
  responseType: "arraybuffer",
  transitional: { clarifyTimeoutError: true },
});

async function fetchText(url) {
  const hit = cached(textCache, url);
  if (hit) return hit;
  const { data } = await http.get(url);
  store(textCache, url, data);
  return data;
}

async function fetchBinary(url) {
  const hit = cached(binCache, url);
  if (hit) return hit;
  const res = await httpBin.get(url);
  if (res.data.length > MAX_IMAGE_SIZE) {
    throw new Error(`Image too large (${res.data.length} bytes)`);
  }
  const mime = res.headers["content-type"]?.split(";")[0] || "application/octet-stream";
  const result = { buf: Buffer.from(res.data), mime };
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
    let path = match[2].trim();
    if (!path || path.startsWith("data:") || path.startsWith("#")) continue;

    const fullUrl = urlLib.resolve(baseUrl, path);
    replacements.push({
      idx: match.index,
      len: match[0].length,
      promise: (async () => {
        try {
          const { buf, mime } = await fetchBinary(fullUrl);
          return `url(${match[1]}data:${mime};base64,${buf.toString("base64")}${match[1]})`;
        } catch {
          return match[0];
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

app.post("/inline", async (req, res) => {
  const { url, scripts = true, styles = true, images = false } = req.body;

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  try {
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
              console.log(`Style @import resolution failed`);
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
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
