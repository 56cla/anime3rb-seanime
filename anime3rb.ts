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
            const searchStr = this.api + "/episode/" + id + "/"
            var idx = 0
            while (true) {
                idx = html.indexOf(searchStr, idx)
                if (idx === -1) break
                // Find the end of the number
                var start = idx + searchStr.length
                var end = start
                while (end < html.length && html.charAt(end) >= "0" && html.charAt(end) <= "9") {
                    end++
                }
                if (end > start) {
                    var n = parseInt(html.substring(start, end), 10)
                    if (n && !map[n]) {
                        map[n] = {
                            id: id + "/" + n,
                            number: n,
                            title: "Episode " + n,
                            url: this.api + "/episode/" + id + "/" + n,
                        }
                    }
                }
                idx = end
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

            // Extract all possible player URLs from the episode page
            const dec = this.dec(html)
            let playerUrl = ""
            let embedUrl = ""
            var uuid = ""

            // 1) iframe src (vid3rb URL with token)
            const ifr = dec.match(/iframe[^>]+src=["'](https?:\/\/[^"']+)["']/)
            if (ifr && ifr[1]) {
                playerUrl = ifr[1].replace(/&amp;/g, "&")
                var u = playerUrl.match(/player\/([a-f0-9-]+)/)
                if (u) uuid = u[1]
            }

            // 2) JSON-LD embedUrl (anime3rb.com/embed/)
            if (!embedUrl) {
                const ld = dec.match(/"embedUrl"\s*:\s*"(https?:[^"]+)"/)
                if (ld && ld[1]) {
                    embedUrl = ld[1].replace(/\\\//g, "/").replace(/&amp;/g, "&")
                    if (!uuid) {
                        var u2 = embedUrl.match(/embed\/([a-f0-9-]+)/)
                        if (u2) uuid = u2[1]
                    }
                }
            }

            if (!playerUrl && !embedUrl) {
                return { server: "Anime3rb", headers: { Referer: epUrl, "User-Agent": this.userAgent }, videoSources: [] }
            }

            // Try to get video sources from multiple approaches
            let sources: any[] = []

            // Extract token from player URL
            var token = ""
            var tMatch = playerUrl.match(/token=([a-f0-9]+)/)
            if (tMatch) token = tMatch[1]

            // Helper to try fetching a JSON API endpoint
            const tryAPI = async function(baseUrl, refTok) {
                try {
                    var r = await fetch(baseUrl, {
                        headers: { "User-Agent": this.userAgent, "Referer": epUrl, "Accept": "application/json", "Origin": this.api },
                        noCloudflareBypass: true,
                        timeout: 15,
                    })
                    if (r.ok) {
                        var b = r.json()
                        var items = b && b.data ? b.data : (b && b.sources ? b.sources : (b && b.results ? b.results : b))
                        if (Array.isArray(items) && items.length > 0) return items
                    }
                } catch (e) {}
                return null
            }

            // API endpoint patterns to try (vid3rb.com)
            if (uuid && token) {
                var apis = [
                    "/api/sources/", "/api/video/", "/api/manifest/",
                    "/api/stream/", "/api/play/", "/api/url/",
                    "/source/", "/hls/",
                ]
                for (var i = 0; i < apis.length; i++) {
                    var apiUrl = this.videoApi + apis[i] + uuid + "?token=" + token
                    var result = await tryAPI(apiUrl, epUrl)
                    if (result) { sources = result; break }
                }
            }

            // Try embed URL (same domain - might return HTML with sources)
            if (sources.length === 0 && embedUrl) {
                try {
                    var embedHtml = await this.get(embedUrl, epUrl)
                    var embedDec = this.dec(embedHtml)
                    // Look for video source patterns in the embed page
                    var pats = [/var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/g, /sources\s*[:=]\s*(\[[\s\S]*?\])/g, /"sources"\s*:\s*(\[[\s\S]*?\])/g, /src:\s*["']([^"']+)["']/g]
                    for (var pi = 0; pi < pats.length; pi++) {
                        var sm = pats[pi].exec(embedDec)
                        if (sm && sm[1]) {
                            try {
                                var parsed = JSON.parse(sm[1])
                                if (Array.isArray(parsed) && parsed.length > 0) { sources = parsed; break }
                            } catch (ex) {
                                if (sm[1].indexOf("http") >= 0) {
                                    sources = [{ src: sm[1], type: "mp4", label: "Auto", res: "Auto", premium: false }]
                                    break
                                }
                            }
                        }
                    }
                } catch (e) {}
            }
            
            // Try the player page HTML directly
            if (sources.length === 0 && playerUrl) {
                try {
                    var ph = await this.get(playerUrl, epUrl)
                    var pd = this.dec(ph)
                    var pats = [/var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/g, /sources\s*[:=]\s*(\[[\s\S]*?\])/g, /"sources"\s*:\s*(\[[\s\S]*?\])/g, /src:\s*["']([^"']+)["']/g]
                    for (var pi = 0; pi < pats.length; pi++) {
                        var sm = pats[pi].exec(pd)
                        if (sm && sm[1]) {
                            try {
                                var parsed = JSON.parse(sm[1])
                                if (Array.isArray(parsed) && parsed.length > 0) { sources = parsed; break }
                            } catch (ex) {
                                if (sm[1].indexOf("http") >= 0) {
                                    sources = [{ src: sm[1], type: "mp4", label: "Auto", res: "Auto", premium: false }]
                                    break
                                }
                            }
                        }
                    }
                } catch (e) {}
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

            // Ultimate fallback: return player URL as source
            if (vids.length === 0) {
                var fallbackUrl = playerUrl || embedUrl || ""
                if (fallbackUrl) {
                    vids.push({
                        url: fallbackUrl,
                        type: "unknown",
                        quality: "Auto",
                        subtitles: [],
                    })
                }
            }

            return {
                server: "Anime3rb",
                headers: {
                    Referer: playerUrl || embedUrl || epUrl,
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
            },
            noCloudflareBypass: false,
            timeout: 35,
        })
        if (!res.ok) throw new Error("HTTP " + res.status + " -- " + url)
        // Return res.text() - the body is already decoded by Seanime's fetch
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
