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
        const empty: EpisodeServer = { server: "Anime3rb", headers: { "User-Agent": this.userAgent }, videoSources: [] }
        try {
            const epPath = episode.id.indexOf("/") >= 0 ? episode.id : episode.url.replace(this.api + "/episode/", "")
            const epUrl = this.api + "/episode/" + epPath

            // Step 1: Get the episode page
            const html = await this.get(epUrl, this.api + "/")
            const dec = this.dec(html)

            var playerUrl = ""
            var uuid = ""
            var token = ""

            // Extract iframe src (vid3rb player URL with token)
            const ifr = dec.match(/iframe[^>]+src=["'](https?:\/\/[^"']+)["']/)
            if (ifr && ifr[1]) {
                playerUrl = ifr[1].replace(/&amp;/g, "&")
                var um = playerUrl.match(/player\/([a-f0-9-]+)/)
                if (um) uuid = um[1]
                var tm = playerUrl.match(/[?&]token=([a-f0-9]+)/)
                if (tm) token = tm[1]
            }

            // Also try JSON-LD embedUrl
            if (!uuid) {
                const ld = dec.match(/"embedUrl"\s*:\s*"(https?:[^"]+)"/)
                if (ld && ld[1]) {
                    var embedUrl = ld[1].replace(/\\\//g, "/").replace(/&amp;/g, "&")
                    var um2 = embedUrl.match(/embed\/([a-f0-9-]+)/)
                    if (um2) uuid = um2[1]
                    if (!token) {
                        var tm2 = embedUrl.match(/[?&]token=([a-f0-9]+)/)
                        if (tm2) token = tm2[1]
                    }
                }
            }

            if (!uuid) return empty

            // Step 2: Fetch the player page to get the real m3u8 sources
            // We fetch it with proper browser-like headers including the token as cookie
            var referer = playerUrl || (this.videoApi + "/player/" + uuid + "?token=" + token)
            var playerHtml = ""
            try {
                var playerRes = await fetch(referer, {
                    headers: {
                        "User-Agent": this.userAgent,
                        "Referer": epUrl,
                        "Origin": this.api,
                        "Accept": "text/html,application/xhtml+xml,*/*",
                        "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
                        "Cookie": token ? "token=" + token : "",
                    },
                    noCloudflareBypass: false,
                    timeout: 20,
                })
                if (playerRes.ok) playerHtml = this.dec(playerRes.text())
            } catch (e) {}

            // Step 3: Extract sources from player page
            var sources: any[] = []

            if (playerHtml) {
                // Pattern 1: var video_sources = [...]
                var m1 = playerHtml.match(/var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/)
                if (m1 && m1[1]) {
                    try { sources = JSON.parse(m1[1]) } catch (e) {}
                }
                // Pattern 2: sources: [...] or "sources": [...]
                if (!sources.length) {
                    var m2 = playerHtml.match(/["\s]sources["\s]*[:=]\s*(\[[\s\S]*?\])/)
                    if (m2 && m2[1]) {
                        try { sources = JSON.parse(m2[1]) } catch (e) {}
                    }
                }
                // Pattern 3: file: "url.m3u8" or src: "url.m3u8"
                if (!sources.length) {
                    var m3 = playerHtml.match(/(?:file|src)\s*:\s*["']([^"']+\.m3u8[^"']*)["']/)
                    if (m3 && m3[1]) {
                        sources = [{ src: m3[1].replace(/&amp;/g, "&"), type: "application/x-mpegURL", label: "Auto" }]
                    }
                }
                // Pattern 4: "file":"url" json style
                if (!sources.length) {
                    var m4 = playerHtml.match(/"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/)
                    if (m4 && m4[1]) {
                        sources = [{ src: m4[1].replace(/\\\/|\\\//g, "/").replace(/&amp;/g, "&"), type: "application/x-mpegURL", label: "Auto" }]
                    }
                }
            }

            // Step 4: If no sources from player page, build m3u8 URL directly
            // vid3rb serves HLS at /hls/{uuid}/master.m3u8?token=xxx or /hls/{uuid}/index.m3u8?token=xxx
            if (!sources.length && uuid && token) {
                var directUrls = [
                    this.videoApi + "/hls/" + uuid + "/master.m3u8?token=" + token,
                    this.videoApi + "/hls/" + uuid + "/index.m3u8?token=" + token,
                    this.videoApi + "/stream/" + uuid + "/master.m3u8?token=" + token,
                    this.videoApi + "/video/" + uuid + "/master.m3u8?token=" + token,
                ]
                for (var di = 0; di < directUrls.length; di++) {
                    try {
                        var testRes = await fetch(directUrls[di], {
                            headers: {
                                "User-Agent": this.userAgent,
                                "Referer": referer,
                                "Origin": this.videoApi,
                                "Cookie": token ? "token=" + token : "",
                            },
                            noCloudflareBypass: false,
                            timeout: 8,
                        })
                        if (testRes.ok) {
                            var testBody = testRes.text()
                            if (testBody.indexOf("#EXTM3U") >= 0 || testBody.indexOf("#EXT-X") >= 0) {
                                sources = [{ src: directUrls[di], type: "application/x-mpegURL", label: "Auto" }]
                                break
                            }
                        }
                    } catch (e) {}
                }
            }

            // Step 5: Build VideoSources
            const vids: VideoSource[] = []
            for (var si = 0; si < sources.length; si++) {
                var s = sources[si]
                if (!s || !s.src || s.premium) continue
                var src = s.src.split("\\/").join("/").replace(/&amp;/g, "&")
                var mime = (s.type || "").toLowerCase()
                var ext = src.toLowerCase()

                // Append token if missing from vid3rb URLs
                if ((ext.indexOf(".m3u8") >= 0 || mime.indexOf("mpegurl") >= 0) &&
                    token && src.indexOf(this.videoApi) === 0 &&
                    src.indexOf("token=") === -1) {
                    src = src + (src.indexOf("?") >= 0 ? "&" : "?") + "token=" + token
                }

                var vidType = "unknown"
                if (ext.indexOf(".mp4") >= 0 || mime.indexOf("mp4") >= 0) {
                    vidType = "mp4"
                } else if (ext.indexOf(".m3u8") >= 0 || mime.indexOf("mpegurl") >= 0) {
                    vidType = "m3u8"
                }

                vids.push({
                    url: src,
                    type: vidType,
                    quality: this.cln(s.label || s.res || "Auto"),
                    subtitles: [],
                })
            }

            return {
                server: "Anime3rb",
                headers: {
                    "Referer": referer,
                    "Origin": this.videoApi,
                    "User-Agent": this.userAgent,
                    "Cookie": token ? "token=" + token : "",
                },
                videoSources: vids,
            }
        } catch (e) {
            return empty
        }
    }

    // ── helpers ──

    makeSlugs(name: string): string[] {
        if (!name) return []
        let s = name.toLowerCase().trim()
        s = s.replace(/\([^)]*\)/g, "").trim()
        const accents: [RegExp, string][] = [
            [/[\u00e9\u00e8\u00ea\u00eb]/g, "e"], [/[\u00e1\u00e0\u00e2\u00e4]/g, "a"],
            [/[\u00ed\u00ec\u00ee\u00ef]/g, "i"], [/[\u00f3\u00f2\u00f4\u00f6]/g, "o"],
            [/[\u00fa\u00f9\u00fb\u00fc]/g, "u"], [/[\u00f1]/g, "n"],
            [/[\u00e7]/g, "c"], [/[\u014d]/g, "o"], [/[\u016b]/g, "u"], [/[\u0101]/g, "a"],
        ]
        for (const [re, ch] of accents) s = s.replace(re, ch)
        s = s.replace(/['':;.\u3001\u3002\uff01\uff1f\u30fb]/g, " ")
        s = s.replace(/\s*;\s*/g, "-")
        s = s.replace(/[^a-z0-9\s\u0600-\u06FF-]/g, " ")
        s = s.replace(/\s+/g, "-")
        s = s.replace(/-+/g, "-")
        s = s.replace(/^-|-$/g, "")
        if (!s) return []

        const slugs: string[] = [s]

        const stripSW = function (x: string): string {
            let r = x
            for (const w of ["no", "to", "the", "a", "an", "of", "and", "wa", "ga", "ni", "o", "de", "mo"]) {
                r = r.replace(new RegExp("-" + w + "-", "g"), "-")
            }
            return r.replace(/^-|-$/g, "")
        }
        const stripped = stripSW(s)
        if (stripped !== s && slugs.indexOf(stripped) === -1) slugs.push(stripped)

        const noPart = s.replace(/-season-\d+/g, "").replace(/-part-\d+/g, "").replace(/-cour-\d+/g, "")
        if (noPart !== s && slugs.indexOf(noPart) === -1) slugs.push(noPart)

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
        return res.text()
    }

    dec(v: string): string {
        return (v || "")
            .replace(/&quot;/g, "\"").replace(/&#039;/g, "'")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    }

    cln(v: string): string {
        return this.dec(v || "").replace(/\s+/g, " ").trim()
    }
}