/// <reference path="./online-streaming-provider.d.ts" />

type Anime3rbVideoSource = {
    src: string
    type: string
    label: string
    res: string
    premium: boolean
}

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

    // ── PUBLIC: called by Seanime runtime ──────────────────────────────────

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        try {
            return await this._search(opts)
        } catch (_) {
            return []
        }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        try {
            return await this._findEpisodes(id)
        } catch (_) {
            return []
        }
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        try {
            return await this._findEpisodeServer(episode)
        } catch (_) {
            // Return a minimal valid EpisodeServer so Go doesn't get nil
            return {
                server: "Anime3rb",
                headers: {
                    Referer: this.api + "/",
                    "User-Agent": this.userAgent,
                },
                videoSources: [],
                subtitles: [],
            }
        }
    }

    // ── INTERNALS ──────────────────────────────────────────────────────────

    private async _search(opts: SearchOptions): Promise<SearchResult[]> {
        const names: string[] = []
        if (opts.media?.romajiTitle) names.push(opts.media.romajiTitle)
        if (opts.media?.englishTitle) names.push(opts.media.englishTitle)
        if (opts.query) names.push(opts.query)
        if (names.length === 0) return []

        const uniqueSlugs = new Set<string>()
        for (const name of names) {
            for (const slug of this.nameToSlugCandidates(name)) {
                uniqueSlugs.add(slug)
            }
        }

        const results: SearchResult[] = []
        for (const slug of uniqueSlugs) {
            if (await this.slugExists(slug)) {
                results.push({
                    id: slug,
                    title: this.titleFromSlug(slug),
                    url: `${this.api}/titles/${slug}`,
                    subOrDub: "sub",
                })
            }
        }
        return results
    }

    private async _findEpisodes(slug: string): Promise<EpisodeDetails[]> {
        const html = await this.httpGet(
            `${this.api}/titles/${slug}`,
            `${this.api}/titles/${slug}`
        )

        const episodes = new Map<number, EpisodeDetails>()
        const re = new RegExp(
            `href=["']/episode/${this.escapeRe(slug)}/(\\d+)[\"']`,
            "gi"
        )
        let m: RegExpExecArray | null
        while ((m = re.exec(html)) !== null) {
            const n = parseInt(m[1], 10)
            if (n && !episodes.has(n)) {
                episodes.set(n, {
                    id: `${slug}/${n}`,
                    number: n,
                    title: `Episode ${n}`,
                    url: `${this.api}/episode/${slug}/${n}`,
                })
            }
        }

        // Fallback: broad pattern for any episode link on the page
        if (episodes.size === 0) {
            const re2 = /href=["']\/episode\/([^"'\/]+)\/(\d+)["']/gi
            while ((m = re2.exec(html)) !== null) {
                const n = parseInt(m[2], 10)
                if (n && !episodes.has(n)) {
                    episodes.set(n, {
                        id: `${slug}/${n}`,
                        number: n,
                        title: `Episode ${n}`,
                        url: `${this.api}/episode/${slug}/${n}`,
                    })
                }
            }
        }

        return Array.from(episodes.values()).sort((a, b) => a.number - b.number)
    }

    private async _findEpisodeServer(ep: EpisodeDetails): Promise<EpisodeServer> {
        const epPath = ep.id.indexOf("/") >= 0
            ? ep.id
            : ep.url.replace(`${this.api}/episode/`, "")
        const epUrl = `${this.api}/episode/${epPath}`
        const html = await this.httpGet(epUrl, `${this.api}/`)

        // 1) Extract embed/player URL from the page
        const decoded = this.decodeHtml(html)
        let playerUrl = ""

        // 1a) JSON-LD embedUrl (most reliable, server-rendered)
        const jld = decoded.match(/"embedUrl"\s*:\s*"(https?:[^"]+)"/)
        if (jld && jld[1]) playerUrl = jld[1].replace(/\\\//g, "/").replace(/&amp;/g, "&")

        // 1b) iframe src
        if (!playerUrl) {
            const ifr = decoded.match(/iframe[^>]+src=["'](https?:\/\/[^"']+)["']/)
            if (ifr && ifr[1]) playerUrl = ifr[1].replace(/&amp;/g, "&")
        }

        // 1c) data attribute
        if (!playerUrl) {
            const dat = decoded.match(/data-(?:src|url|embed)=["'](https?:\/\/[^"']+)["']/)
            if (dat && dat[1]) playerUrl = dat[1].replace(/&amp;/g, "&")
        }

        // 1d) vid3rb URL with optional escaped slashes
        if (!playerUrl) {
            const v3 = decoded.match(/https?:\\?\/\\?\/video\.vid3rb\.com\\?\/player\\?\/[^"'\s<>]+/)
            if (v3 && v3[0]) playerUrl = v3[0].replace(/\\\//g, "/")
        }

        if (!playerUrl) {
            return this.fallbackServer(epUrl, [])
        }

        // Resolve relative URLs
        if (playerUrl.indexOf("http") !== 0) {
            if (playerUrl.indexOf("//") === 0) playerUrl = "https:" + playerUrl
            else if (playerUrl.indexOf("/") === 0) playerUrl = this.api + playerUrl
            else playerUrl = `${this.api}/${playerUrl}`
        }

        // 2) Get video sources from player/embed page
        let sources: Anime3rbVideoSource[] = []

        // 2a) Try the embed URL (anime3rb.com/embed/...)
        if (playerUrl.includes("/embed/")) {
            try {
                const embedHtml = await this.httpGet(playerUrl, epUrl)
                sources = this.parseSources(embedHtml)
            } catch (_) {}
        }

        // 2b) Try the vid3rb player page
        if (sources.length === 0) {
            try {
                const playerHtml = await this.httpGet(playerUrl, epUrl)
                sources = this.parseSources(playerHtml)
            } catch (_) {}
        }

        // 2c) Try vid3rb JSON API
        if (sources.length === 0) {
            const uuid = playerUrl.match(/player\/([a-f0-9-]+)/)
            if (uuid) {
                try {
                    const apiRes = await fetch(`${this.videoApi}/api/sources/${uuid[1]}`, {
                        headers: {
                            "User-Agent": this.userAgent,
                            "Referer": epUrl,
                            "Accept": "application/json",
                            "Origin": this.api,
                        },
                    })
                    if (apiRes.ok) {
                        const body = await apiRes.json()
                        const items: Anime3rbVideoSource[] = body.data || body.sources || body || []
                        if (Array.isArray(items)) sources = items
                    }
                } catch (_) {}
            }
        }

        if (sources.length === 0) {
            return this.fallbackServer(playerUrl, [])
        }

        const videoSources: VideoSource[] = []
        for (const s of sources) {
            if (!s || !s.src || s.premium) continue
            videoSources.push({
                url: s.src.replace(/\\\//g, "/"),
                type: s.type && s.type.indexOf("mp4") >= 0 ? "mp4" : "unknown",
                quality: this.clean(s.label || s.res || "Auto"),
                label: this.clean(s.res || s.label || ""),
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
            videoSources,
        }
    }

    private fallbackServer(referer: string, sources: VideoSource[]): EpisodeServer {
        return {
            server: "Anime3rb",
            headers: {
                Referer: referer || this.api + "/",
                "User-Agent": this.userAgent,
            },
            videoSources: sources,
        }
    }

    // ── SOURCE PARSING ─────────────────────────────────────────────────────

    private parseSources(html: string): Anime3rbVideoSource[] {
        const decoded = this.decodeHtml(html)
        const patterns = [
            /var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/g,
            /sources\s*[:=]\s*(\[[\s\S]*?\])/g,
            /file_sources\s*[:=]\s*(\[[\s\S]*?\])/g,
            /"sources"\s*:\s*(\[[\s\S]*?\])/g,
        ]
        for (const pat of patterns) {
            let m: RegExpExecArray | null
            while ((m = pat.exec(decoded)) !== null) {
                if (m[1] && m[1] !== "[]") {
                    try {
                        const parsed = JSON.parse(m[1])
                        if (Array.isArray(parsed) && parsed.length > 0) return parsed
                    } catch (_) {}
                }
            }
        }
        return []
    }

    // ── SLUG MATCHING ─────────────────────────────────────────────────────

    private nameToSlugCandidates(name: string): string[] {
        if (!name) return []

        let s = name
            .toLowerCase()
            .trim()
            .replace(/\([^)]*\)/g, "") // (TV), (2024), etc.
            .trim()

        // Accent normalisation
        const accents: [RegExp, string][] = [
            [/[\u00e9\u00e8\u00ea\u00eb]/g, "e"],
            [/[\u00e1\u00e0\u00e2\u00e4]/g, "a"],
            [/[\u00ed\u00ec\u00ee\u00ef]/g, "i"],
            [/[\u00f3\u00f2\u00f4\u00f6]/g, "o"],
            [/[\u00fa\u00f9\u00fb\u00fc]/g, "u"],
            [/[\u00f1]/g, "n"],
            [/[\u00e7]/g, "c"],
            [/[\u014d]/g, "o"],
            [/[\u016b]/g, "u"],
            [/[\u0101]/g, "a"],
        ]
        for (const [re, ch] of accents) {
            s = s.replace(re, ch)
        }

        // Punctuation to space
        s = s.replace(/['':;.\u3001\u3002\uff01\uff1f\u30fb]/g, " ")
            .replace(/\s*;\s*/g, "-")
            // Keep only alphanumeric, Arabic, hyphens
            .replace(/[^a-z0-9\s\u0600-\u06FF-]/g, " ")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")

        if (!s) return []

        const set = new Set<string>([s])

        // Strip Japanese stop words (no, to, wa, ga, ni, o, de, mo, the, a, an, of, and)
        const strip = (x: string) => {
            let r = x
            for (const w of ["no", "to", "the", "a", "an", "of", "and", "wa", "ga", "ni", "o", "de", "mo"]) {
                r = r.replace(new RegExp(`-${w}-`, "g"), "-")
            }
            return r.replace(/^-|-$/g, "")
        }
        const a = strip(s)
        if (a !== s) set.add(a)

        // Remove season/part/cour
        const b = s.replace(/-season-\d+/g, "").replace(/-part-\d+/g, "").replace(/-cour-\d+/g, "")
        if (b !== s) set.add(b)

        // No hyphens
        const c = s.replace(/-/g, "")
        if (c !== s) set.add(c)

        // CamelCase hyphenation (for titles like "SteinsGate" → "steins-gate")
        const d = c.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
        if (d !== c) set.add(d)

        // Combined
        const e = strip(b)
        if (e !== s && e !== a && e !== b) set.add(e)

        return Array.from(set).filter((x) => x.length > 0)
    }

    private async slugExists(slug: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.api}/titles/${slug}`, {
                headers: {
                    "User-Agent": this.userAgent,
                    "Accept": "text/html",
                },
            })
            if (!res.ok) return false
            const text = await res.text()
            // "غير موجودة" = "not found" in Arabic
            if (text.indexOf("غير موجودة") >= 0) return false
            return true
        } catch (_) {
            return false
        }
    }

    private titleFromSlug(slug: string): string {
        return slug
            .split("-")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ")
    }

    // ── HTTP ───────────────────────────────────────────────────────────────

    private async httpGet(url: string, referer: string): Promise<string> {
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
        if (!res.ok) throw new Error(`HTTP ${res.status} -- ${url}`)
        return res.text()
    }

    // ── HELPERS ────────────────────────────────────────────────────────────

    private clean(v: string): string {
        return this.decodeHtml(v || "").replace(/\s+/g, " ").trim()
    }

    private decodeHtml(v: string): string {
        return (v || "")
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
    }

    private escapeRe(v: string): string {
        return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
}
