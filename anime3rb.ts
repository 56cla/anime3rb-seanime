/// <reference path="./online-streaming-provider.d.ts" />

type Anime3rbVideoSource = {
    src: string
    type: string
    label: string
    res: string
    premium: boolean
}

type Anime3rbEmbedData = {
    video_url?: string
    embed_url?: string
    embedUrl?: string
    player_url?: string
    token?: string
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

    /**
     * Normalize a title for slug matching -- handles special chars, accents, and
     * strips parenthetical suffixes like "(TV)", "(2024)", etc.
     */
    normalizeTitle(title: string): string {
        let s = title
            .toLowerCase()
            .trim()
            .replace(/\([^)]*\)/g, "")
            .trim()

        // Normalize accented chars to ASCII
        const accentMap: { [key: string]: string } = {
            "\u00e9": "e", "\u00e8": "e", "\u00ea": "e", "\u00eb": "e",
            "\u00e1": "a", "\u00e0": "a", "\u00e2": "a", "\u00e4": "a",
            "\u00ed": "i", "\u00ec": "i", "\u00ee": "i", "\u00ef": "i",
            "\u00f3": "o", "\u00f2": "o", "\u00f4": "o", "\u00f6": "o",
            "\u00fa": "u", "\u00f9": "u", "\u00fb": "u", "\u00fc": "u",
            "\u00f1": "n", "\u00e7": "c", "\u00ff": "y",
            "\u014d": "o", "\u016b": "u", "\u0101": "a",
        }
        s = s.replace(/[\u00e9\u00e8\u00ea\u00eb\u00e1\u00e0\u00e2\u00e4\u00ed\u00ec\u00ee\u00ef\u00f3\u00f2\u00f4\u00f6\u00fa\u00f9\u00fb\u00fc\u00f1\u00e7\u00ff\u014d\u016b\u0101]/g, (c: string) => {
            return (accentMap as any)[c] || c
        })

        // Replace special punctuation with hyphens
        s = s
            .replace(/['':;.\u3001\u3002\u3001\uff01\uff1f\u30fb]/g, " ")
            .replace(/\s*;\s*/g, "-")

        // Keep only alphanumeric + Arabic + spaces
        s = s.replace(/[^a-z0-9\s\u0600-\u06FF-]/g, " ")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")

        return s
    }

    /**
     * Generate a comprehensive set of slug candidates from a title.
     * Tries various common transformations to match anime3rb's actual slug format.
     */
    nameToSlugCandidates(name: string): string[] {
        const base = this.normalizeTitle(name)
        if (!base) return []

        const candidates = new Set<string>()
        candidates.add(base)

        // Remove common Japanese name prefixes
        const stripPrefixes = (s: string) => {
            let r = s
            const stopWords = ["no", "to", "the", "a", "an", "of", "and", "wa", "ga", "ni", "o", "de", "mo"]
            for (const w of stopWords) {
                const pat = new RegExp(`-${w}-`, "g")
                r = r.replace(pat, "-")
            }
            return r.replace(/^-|-$/g, "")
        }
        const stripped = stripPrefixes(base)
        if (stripped !== base) candidates.add(stripped)

        // Drop season/part/cour suffixes
        const stripped2 = base
            .replace(/-season-\d+/g, "")
            .replace(/-part-\d+/g, "")
            .replace(/-cour-\d+/g, "")
        if (stripped2 !== base) candidates.add(stripped2)

        // Handle semicolon-style separators
        const noHyphen = base.replace(/-/g, "")
        if (noHyphen !== base) candidates.add(noHyphen)
        const withHyphenFromNoHyphen = noHyphen.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
        if (withHyphenFromNoHyphen !== noHyphen) candidates.add(withHyphenFromNoHyphen)

        // Combined: stripped prefixes + no season
        const stripped3 = stripPrefixes(stripped2)
        if (stripped3 !== base && stripped3 !== stripped && stripped3 !== stripped2) {
            candidates.add(stripped3)
        }

        return Array.from(candidates).filter((s) => s.length > 0)
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        // Try the Livewire search endpoint
        const query = (opts.query || opts.media?.romajiTitle || opts.media?.englishTitle || "").trim()

        if (query) {
            try {
                const searchUrl = `${this.api}/search`
                const searchRes = await fetch(searchUrl, {
                    method: "POST",
                    headers: {
                        "User-Agent": this.userAgent,
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "Accept": "application/json, text/plain, */*",
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": searchUrl,
                    },
                    body: `query=${encodeURIComponent(query)}`,
                })
                if (searchRes.ok) {
                    const body = await searchRes.text()
                    const slugMatches = body.match(/\/titles\/([a-z0-9-]+(?:-[a-z0-9-]+)*)/g)
                    if (slugMatches && slugMatches.length > 0) {
                        const seen = new Set<string>()
                        const results: SearchResult[] = []
                        for (const fullUrl of slugMatches) {
                            const sMatch = fullUrl.match(/\/titles\/([a-z0-9-]+(?:-[a-z0-9-]+)*)/)
                            if (!sMatch || !sMatch[1]) continue
                            const slug = sMatch[1]
                            if (seen.has(slug) || slug === "list") continue
                            seen.add(slug)
                            results.push({
                                id: slug,
                                title: this.titleFromSlug(slug),
                                url: `${this.api}/titles/${slug}`,
                                subOrDub: "sub",
                            })
                            if (results.length >= 10) break
                        }
                        if (results.length > 0) return results
                    }
                }
            } catch (_) {}
        }

        // Fallback: slug matching across all name variants
        const names: string[] = []
        if (opts.media?.romajiTitle) names.push(opts.media.romajiTitle)
        if (opts.media?.englishTitle) names.push(opts.media.englishTitle)
        if (opts.query) names.push(opts.query)
        if (names.length === 0) return []

        const uniqueSlugs = new Set<string>()
        for (const name of names) {
            const candidates = this.nameToSlugCandidates(name)
            for (const slug of candidates) {
                uniqueSlugs.add(slug)
            }
        }

        const results: SearchResult[] = []
        for (const slug of uniqueSlugs) {
            const exists = await this.checkSlugExists(slug)
            if (exists) {
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

    titleFromSlug(slug: string): string {
        return slug
            .split("-")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ")
    }

    async checkSlugExists(slug: string): Promise<boolean> {
        try {
            const response = await fetch(`${this.api}/titles/${slug}`, {
                headers: {
                    "User-Agent": this.userAgent,
                    "Accept": "text/html",
                },
            })
            if (!response.ok) return false
            const text = await response.text()
            if (text.indexOf("غير موجودة") >= 0 || text.indexOf("404") >= 0) return false
            return true
        } catch (_) {
            return false
        }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const slug = this.titleSlugFromUrl(id) || id

        const html = await this.fetchText(
            `${this.api}/titles/${slug}`,
            `${this.api}/titles/${slug}`
        )

        const episodesByNumber: { [key: string]: EpisodeDetails } = {}

        const patterns = [
            new RegExp(`href=["']/episode/${this.escapeRegExp(slug)}/(\\d+)[\"']`, "gi"),
            new RegExp(`["']${this.escapeRegExp(this.api)}/episode/${this.escapeRegExp(slug)}/(\\d+)[\"']`, "gi"),
            /href=["']\/episode\/([^"'\/]+)\/(\d+)["']/gi,
        ]

        for (const pattern of patterns) {
            let match: RegExpExecArray | null
            while ((match = pattern.exec(html)) !== null) {
                const epSlug = match[1] || slug
                const number = parseInt(match[match.length - 1], 10)
                if (!number || episodesByNumber[String(number)]) continue
                episodesByNumber[String(number)] = {
                    id: `${slug}/${number}`,
                    number,
                    title: `Episode ${number}`,
                    url: `${this.api}/episode/${slug}/${number}`,
                }
            }
            if (Object.keys(episodesByNumber).length > 0) break
        }

        const episodes = Object.keys(episodesByNumber)
            .map((key) => episodesByNumber[key])
            .sort((a, b) => a.number - b.number)

        if (episodes.length === 0) {
            throw new Error("No episodes found for: " + slug)
        }

        return episodes
    }

    async findEpisodeServer(episode: EpisodeDetails, _server: string): Promise<EpisodeServer> {
        const episodePath = episode.id.indexOf("/") >= 0
            ? episode.id
            : episode.url.replace(`${this.api}/episode/`, "")

        const episodeUrl = `${this.api}/episode/${episodePath}`
        const html = await this.fetchText(episodeUrl, `${this.api}/`)
        let playerUrl = this.extractPlayerUrl(html)

        if (!playerUrl) {
            playerUrl = this.extractEmbedUrl(html)
        }

        if (!playerUrl) {
            throw new Error("Failed to find player URL for: " + episodeUrl)
        }

        if (playerUrl.indexOf("http") !== 0) {
            if (playerUrl.indexOf("//") === 0) {
                playerUrl = "https:" + playerUrl
            } else if (playerUrl.indexOf("/") === 0) {
                playerUrl = this.api + playerUrl
            } else {
                playerUrl = `${this.api}/${playerUrl}`
            }
        }

        return await this.extractFromPlayer(playerUrl, episodeUrl)
    }

    extractEmbedUrl(html: string): string {
        const decoded = this.decodeHtml(html)
        const jsonLdMatch = decoded.match(/"embedUrl"\s*:\s*"(https?:[^"]+)"/)
        if (jsonLdMatch && jsonLdMatch[1]) return jsonLdMatch[1].replace(/\\\//g, "/").replace(/&amp;/g, "&")

        const jsonMatch = decoded.match(/"video_url"\s*:\s*"(https?:[^"]+)"/)
        if (jsonMatch && jsonMatch[1]) return jsonMatch[1].replace(/\\\//g, "/").replace(/&amp;/g, "&")

        return ""
    }

    async extractFromPlayer(playerUrl: string, referer: string): Promise<EpisodeServer> {
        const sources: Anime3rbVideoSource[] = []

        // Approach 1: if it's an anime3rb embed URL, fetch that first
        if (playerUrl.indexOf(this.api) === 0 || playerUrl.indexOf("anime3rb.com/embed") >= 0) {
            try {
                const embedHtml = await this.fetchText(playerUrl, referer)
                const extracted = this.extractVideoSources(embedHtml)
                if (extracted.length > 0) sources.push(...extracted)
            } catch (_) {}
        }

        // Approach 2: try the vid3rb player page with token
        if (sources.length === 0) {
            try {
                const playerHtml = await this.fetchText(playerUrl, referer)
                const extracted = this.extractVideoSources(playerHtml)
                if (extracted.length > 0) sources.push(...extracted)
            } catch (_) {}
        }

        // Approach 3: try vid3rb API endpoint with the UUID
        if (sources.length === 0) {
            const uuidMatch = playerUrl.match(/player\/([a-f0-9-]+)/)
            if (uuidMatch) {
                const uuid = uuidMatch[1]
                const apiUrl = `${this.videoApi}/api/sources/${uuid}`
                try {
                    const apiRes = await fetch(apiUrl, {
                        headers: {
                            "User-Agent": this.userAgent,
                            "Referer": referer,
                            "Accept": "application/json",
                            "Origin": this.api,
                        },
                    })
                    if (apiRes.ok) {
                        const body = await apiRes.json()
                        const items: Anime3rbVideoSource[] = body.data || body.sources || body.results || body
                        if (Array.isArray(items)) sources.push(...items)
                    }
                } catch (_) {}
            }
        }

        const videoSources: VideoSource[] = []
        sources.forEach((source) => {
            if (!source || !source.src || source.premium) return
            videoSources.push({
                url: source.src.replace(/\\\//g, "/"),
                type: source.type && source.type.indexOf("mp4") >= 0 ? "mp4" : "unknown",
                quality: this.cleanTitle(source.label || source.res || "Auto"),
                label: this.cleanTitle(source.res || source.label || ""),
                subtitles: [],
            })
        })

        if (videoSources.length === 0) {
            throw new Error("No playable sources found.")
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

    extractVideoSources(html: string): Anime3rbVideoSource[] {
        const decoded = this.decodeHtml(html)
        const patterns = [
            /var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/g,
            /sources\s*[:=]\s*(\[[\s\S]*?\])/g,
            /file_sources\s*[:=]\s*(\[[\s\S]*?\])/g,
            /"sources"\s*:\s*(\[[\s\S]*?\])/g,
        ]
        for (const pattern of patterns) {
            let m: RegExpExecArray | null
            while ((m = pattern.exec(decoded)) !== null) {
                if (m[1] && m[1] !== "[]") {
                    try {
                        const parsed = JSON.parse(m[1]) as Anime3rbVideoSource[]
                        if (Array.isArray(parsed) && parsed.length > 0) return parsed
                    } catch (_) {}
                }
            }
        }
        return []
    }

    async fetchText(url: string, referer: string): Promise<string> {
        const response = await fetch(url, {
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

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} -- ${url}`)
        }

        return response.text()
    }

    extractPlayerUrl(html: string): string {
        const decoded = this.decodeHtml(html)
        const patterns = [
            /"video_url"\s*:\s*"(https?:[^"]+)"/,
            /"embed_url"\s*:\s*"(https?:[^"]+)"/,
            /https?:\\?\/\\?\/video\.vid3rb\.com\\?\/player\\?\/[^"'\s<>]+/,
            /iframe[^>]+src=["'](https?:\/\/[^"']+)["']/,
            /data-(?:src|url|embed)=["'](https?:\/\/[^"']+)["']/,
        ]
        for (const pattern of patterns) {
            const m = decoded.match(pattern)
            if (m && m[1]) return m[1].replace(/\\\//g, "/").replace(/&amp;/g, "&")
            if (m && m[0] && !m[1]) return m[0].replace(/\\\//g, "/").replace(/&amp;/g, "&")
        }
        return ""
    }

    titleSlugFromUrl(url: string): string {
        const m = url.match(/\/titles\/([^?#/]+)/)
        return m && m[1] ? m[1] : ""
    }

    cleanTitle(value: string): string {
        return this.decodeHtml(value || "").replace(/\s+/g, " ").trim()
    }

    decodeHtml(value: string): string {
        return (value || "")
            .replace(/&quot;/g, "\"")
            .replace(/&#039;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
    }

    escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
}
