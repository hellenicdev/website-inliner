const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const urlLib = require("url");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const TIMEOUT = parseInt(process.env.TIMEOUT || "15000");
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "300000");
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY || "10");

const cache = new Map();

function getCached(url) {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  cache.delete(url);
  return null;
}

function setCached(url, data) {
  cache.set(url, { data, ts: Date.now() });
}

const http = axios.create({
  timeout: TIMEOUT,
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; WebsiteInliner/1.0)",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
  maxRedirects: 5,
  responseType: "text",
});

async function fetch(url) {
  const cached = getCached(url);
  if (cached) return cached;
  const { data } = await http.get(url);
  setCached(url, data);
  return data;
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

function resolveCssUrls(css, baseUrl) {
  return css.replace(
    /url\(\s*(['"]?)((?:[^'")\s]|\\[^])*?)\1\s*\)/g,
    (match, quote, path) => {
      path = path.trim();
      if (
        !path ||
        path.startsWith("data:") ||
        path.startsWith("#") ||
        path.startsWith("//")
      ) {
        return match;
      }
      try {
        return `url(${quote}${urlLib.resolve(baseUrl, path)}${quote})`;
      } catch {
        return match;
      }
    },
  );
}

async function inlineImports(css, baseUrl) {
  const IMPORT_RE =
    /@import\s+(?:url\(\s*['"]?([^'")\s]+)['"]?\s*\)|['"]([^'"]+)['"])\s*;?/g;
  let result = css;
  let match;

  while ((match = IMPORT_RE.exec(css)) !== null) {
    const importPath = match[1] || match[2];
    if (!importPath) continue;

    try {
      const fullUrl = urlLib.resolve(baseUrl, importPath);
      let imported = await fetch(fullUrl);
      imported = resolveCssUrls(imported, fullUrl);
      imported = await inlineImports(imported, fullUrl);
      result = result.replace(match[0], imported);
    } catch (err) {
      console.log(`@import failed: ${importPath}`);
    }
  }

  return result;
}

app.post("/inline", async (req, res) => {
  const { url, scripts = true, styles = true } = req.body;

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  try {
    const html = await fetch(url);
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
          const fullUrl = urlLib.resolve(url, src);
          try {
            const js = await fetch(fullUrl);
            el.replaceWith(`<script>${js}</script>`);
          } catch (err) {
            console.log(`Script failed: ${fullUrl}`);
          }
        },
        MAX_CONCURRENCY,
      );
    }

    if (styles) {
      const linkTags = [];
      $('link[rel="stylesheet"]').each((_, el) => {
        linkTags.push({ el: $(el), href: $(el).attr("href") });
      });

      await asyncMapLimit(
        linkTags,
        async ({ el, href }) => {
          if (!href) return;
          const fullUrl = urlLib.resolve(url, href);
          try {
            let css = await fetch(fullUrl);
            css = resolveCssUrls(css, fullUrl);
            css = await inlineImports(css, fullUrl);
            el.replaceWith(`<style>${css}</style>`);
          } catch (err) {
            console.log(`Stylesheet failed: ${fullUrl}`);
          }
        },
        MAX_CONCURRENCY,
      );

      const styleTags = [];
      $("style").each((_, el) => {
        const content = $(el).html();
        if (content && content.includes("@import")) {
          styleTags.push({ el: $(el), content });
        }
      });

      await asyncMapLimit(
        styleTags,
        async ({ el, content }) => {
          try {
            const resolved = await inlineImports(content, url);
            el.html(resolved);
          } catch (err) {
            console.log(`Style @import resolution failed`);
          }
        },
        MAX_CONCURRENCY,
      );

      $("[style]").each((_, el) => {
        const style = $(el).attr("style");
        if (style && style.includes("url(")) {
          $(el).attr("style", resolveCssUrls(style, url));
        }
      });
    }

    res.json({ html: $.html() });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
