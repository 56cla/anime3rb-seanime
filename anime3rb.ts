/// <reference path="./online-streaming-provider.d.ts" />

class Provider {
    api = "https://anime3rb.com"
    videoApi = "https://video.vid3rb.com"
    userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

    getSettings(): Settings {
        return {
            episodeServers: ["Anime3rb"],
            supportsDub: false,
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        try {
            const names: string[] = []
            if (opts.media && opts.media.romajiTitle) names.push(opts.media.romajiTitle)
            if (opts.media && opts.media.englishTitle) names.push(opts.media.englishTitle)
            if (opts.query) names.push(opts.query)

            // Collect slug candidates from all names
            const candidates: string[] = []
            for (const n of names) {
                const slugs = this.makeSlugs(n)
                for (const s of slugs) {
                    if (candidates.indexOf(s) === -1) candidates.push(s)
                }
            }

            const results: SearchResult[] = []
            for (const slug of candidates) {
                if (await this.slugOK(slug)) {
                    results.push({
                        id: slug,
                        title: this.titleStr(slug),
                        url: this.api + "/titles/" + slug,
                        subOrDub: "sub",
                    })
                }
            }
            return results
        } catch (e) {
            return []
        }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        try {
            const html = await this.get(this.api + "/titles/" + id, this.api + "/titles/" + id)

            const map: { [key: number]: EpisodeDetails } = {}

            // Relative URL pattern
            let re = new RegExp('href=["\']/episode/' + this.esc(id) + '/(\\d+)["\']', 'gi')
            let m: RegExpExecArray | null
            while ((m = re.exec(html)) !== null) {
                const n = parseInt(m[1], 10)
                if (n && !map[n]) {
                    map[n] = { id: id + "/" + n, number: n, title: "Episode " + n, url: this.api + "/episode/" + id + "/" + n }
                }
            }

            // Absolute URL pattern
            if (Object.keys(map).length === 0) {
                re = new RegExp('href=["\']' + this.esc(this.api) + '/episode/' + this.esc(id) + '/(\\d+)["\']', 'gi')
                while ((m = re.exec(html)) !== null) {
                    const n = parseInt(m[1], 10)
                    if (n && !map[n]) {
                        map[n] = { id: id + "/" + n, number: n, title: "Episode " + n, url: this.api + "/episode/" + id + "/" + n }
                    }
                }
            }

            // Broad absolute pattern
            if (Object.keys(map).length === 0) {
                re = /href=["']https?:\/\/[^"']+\/episode\/([^"'\/]+)\/(\d+)["']/gi
                while ((m = re.exec(html)) !== null) {
                    const slug = m[1]
                    const n = parseInt(m[2], 10)
                    if (n && !map[n]) {
                        map[n] = { id: slug + "/" + n, number: n, title: "Episode " + n, url: this.api + "/episode/" + slug + "/" + n }
                    }
                }
            }

            // Broad relative pattern
            if (Object.keys(map).length === 0) {
                re = /href=["']\/episode\/([^"'\/]+)\/(\d+)["']/gi
                while ((m = re.exec(html)) !== null) {
                    const slug = m[1]
                    const n = parseInt(m[2], 10)
                    if (n && !map[n]) {
                        map[n] = { id: slug + "/" + n, number: n, title: "Episode " + n, url: this.api + "/episode/" + slug + "/" + n }
                    }
                }
            }

            const out: EpisodeDetails[] = Object.keys(map).map(function (k) { return map[parseInt(k, 10)] })
            out.sort(function (a, b) { return a.number - b.number })
            return out
        } catch (e) {
            return []
        }
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        try {
            const epPath = episode.id.indexOf("/") >= 0 ? episode.id : episode.url.replace(this.api + "/episode/", "")
            const epUrl = this.api + "/episode/" + epPath
            const html = await this.get(epUrl, this.api + "/")

            // Try JSON-LD embedUrl first
            let playerUrl = ""
            const dec = this.dec(html)
            const ld = dec.match(/"embedUrl"\s*:\s*"(https?:[^"]+)"/)
            if (ld && ld[1]) {
                playerUrl = ld[1].replace(/\\\//g, "/").replace(/&amp;/g, "&")
            }

            // Try iframe src
            if (!playerUrl) {
                const ifr = dec.match(/iframe[^>]+src=["'](https?:\/\/[^"']+)["']/)
                if (ifr && ifr[1]) playerUrl = ifr[1].replace(/&amp;/g, "&")
            }

            // Try data attribute
            if (!playerUrl) {
                const dat = dec.match(/data-(?:src|url|embed)=["'](https?:\/\/[^"']+)["']/)
                if (dat && dat[1]) playerUrl = dat[1].replace(/&amp;/g, "&")
            }

            if (!playerUrl) {
                return { server: "Anime3rb", headers: { Referer: epUrl, "User-Agent": this.userAgent }, videoSources: [] }
            }

            // Resolve relative
            if (playerUrl.indexOf("http") !== 0) {
                if (playerUrl.indexOf("//") === 0) playerUrl = "https:" + playerUrl
                else if (playerUrl.indexOf("/") === 0) playerUrl = this.api + playerUrl
                else playerUrl = this.api + "/" + playerUrl
            }

            // Try to get video sources
            let sources: any[] = []

            // Try player/embed page
            for (const url of [playerUrl]) {
                try {
                    const ph = await this.get(url, epUrl)
                    const pd = this.dec(ph)
                    const srcPats = [/var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/g, /sources\s*[:=]\s*(\[[\s\S]*?\])/g, /"sources"\s*:\s*(\[[\s\S]*?\])/g]
                    for (const pat of srcPats) {
                        let sm: RegExpExecArray | null
                        while ((sm = pat.exec(pd)) !== null) {
                            if (sm[1] && sm[1] !== "[]") {
                                try {
                                    const parsed = JSON.parse(sm[1])
                                    if (Array.isArray(parsed) && parsed.length > 0) {
                                        sources = parsed
                                        break
                                    }
                                } catch (e) { }
                            }
                        }
                        if (sources.length > 0) break
                    }
                } catch (e) { }
                if (sources.length > 0) break
            }

            const vids: VideoSource[] = []
            for (const s of sources) {
                if (!s || !s.src || s.premium) continue
                vids.push({
                    url: s.src.replace(/\\\//g, "/"),
                    type: s.type && s.type.indexOf("mp4") >= 0 ? "mp4" : "unknown",
                    quality: this.cln(s.label || s.res || "Auto"),
                    label: this.cln(s.res || s.label || ""),
                    subtitles: [],
                })
            }

            return {
                server: "Anime3rb",
                headers: {
                    Referer: playerUrl,
                    Origin: this.videoApi,
                    "User-Agent": this.userAgent,
                },
                videoSources: vids,
            }
        } catch (e) {
            return { server: "Anime3rb", headers: { Referer: this.api + "/", "User-Agent": this.userAgent }, videoSources: [] }
        }
    }

    // ── helpers ──

    makeSlugs(name: string): string[] {
        if (!name) return []
        let s = name.toLowerCase().trim()
        // Strip parenthetical suffixes
        s = s.replace(/\([^)]*\)/g, "").trim()
        // Accent normalisation
        const accents: [RegExp, string][] = [
            [/[\u00e9\u00e8\u00ea\u00eb]/g, "e"], [/[\u00e1\u00e0\u00e2\u00e4]/g, "a"],
            [/[\u00ed\u00ec\u00ee\u00ef]/g, "i"], [/[\u00f3\u00f2\u00f4\u00f6]/g, "o"],
            [/[\u00fa\u00f9\u00fb\u00fc]/g, "u"], [/[\u00f1]/g, "n"],
            [/[\u00e7]/g, "c"], [/[\u014d]/g, "o"], [/[\u016b]/g, "u"], [/[\u0101]/g, "a"],
        ]
        for (const [re, ch] of accents) s = s.replace(re, ch)
        // Punctuation to space
        s = s.replace(/['':;.\u3001\u3002\uff01\uff1f\u30fb]/g, " ")
        s = s.replace(/\s*;\s*/g, "-")
        // Keep only alphanumeric, Arabic, hyphens
        s = s.replace(/[^a-z0-9\s\u0600-\u06FF-]/g, " ")
        s = s.replace(/\s+/g, "-")
        s = s.replace(/-+/g, "-")
        s = s.replace(/^-|-$/g, "")
        if (!s) return []

        const slugs: string[] = [s]

        // Strip stop words
        const stripSW = function (x: string): string {
            let r = x
            for (const w of ["no", "to", "the", "a", "an", "of", "and", "wa", "ga", "ni", "o", "de", "mo"]) {
                r = r.replace(new RegExp("-" + w + "-", "g"), "-")
            }
            return r.replace(/^-|-$/g, "")
        }
        const stripped = stripSW(s)
        if (stripped !== s && slugs.indexOf(stripped) === -1) slugs.push(stripped)

        // Without season/part/cour
        const noPart = s.replace(/-season-\d+/g, "").replace(/-part-\d+/g, "").replace(/-cour-\d+/g, "")
        if (noPart !== s && slugs.indexOf(noPart) === -1) slugs.push(noPart)

        // Combined
        const combo = stripSW(noPart)
        if (combo !== stripped && combo !== noPart && combo !== s && slugs.indexOf(combo) === -1) slugs.push(combo)

        return slugs
    }

    async slugOK(slug: string): Promise<boolean> {
        try {
            const res = await fetch(this.api + "/titles/" + slug, {
                headers: { "User-Agent": this.userAgent, "Accept": "text/html" },
            })
            if (!res.ok) return false
            const text = res.text()
            if (text.indexOf("\u063a\u064a\u0631 \u0645\u0648\u062c\u0648\u062f\u0629") >= 0) return false
            return true
        } catch (e) {
            return false
        }
    }

    titleStr(slug: string): string {
        const parts = slug.split("-")
        for (let i = 0; i < parts.length; i++) {
            parts[i] = parts[i].charAt(0).toUpperCase() + parts[i].slice(1)
        }
        return parts.join(" ")
    }

    async get(url: string, referer: string): Promise<string> {
        const res = await fetch(url, {
            headers: {
                "User-Agent": this.userAgent,
                "Referer": referer,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
                "Connection": "keep-alive",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "same-origin",
                "Cache-Control": "max-age=0",
            },
        })
        if (!res.ok) throw new Error("HTTP " + res.status + " -- " + url)
        return res.text()
    }

    dec(v: string): string {
        return (v || "")
            .replace(/&quot;/g, "\"").replace(/&#039;/g, "'")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    }

    esc(v: string): string {
        return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }

    cln(v: string): string {
        return this.dec(v || "").replace(/\s+/g, " ").trim()
    }
}
