const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const urlLib = require("url");

const app = express();
app.use(cors());
app.use(express.json());

app.post("/inline", async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.json({ error: "No URL provided" });
    }

    try {
        const { data: html } = await axios.get(url);
        const $ = cheerio.load(html);

        const scripts = $("script[src]");

        for (let i = 0; i < scripts.length; i++) {
            const script = scripts[i];
            let src = $(script).attr("src");

            const fullUrl = urlLib.resolve(url, src);

            try {
                const { data: js } = await axios.get(fullUrl);
                $(script).replaceWith(`<script>${js}</script>`);
            } catch (e) {
                console.log("Failed:", fullUrl);
            }
        }

        res.json({ html: $.html() });

    } catch (err) {
        res.json({ error: err.message });
    }
});

app.listen(3000, () => console.log("Server running"));