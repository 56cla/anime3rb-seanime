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

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        // نجمع كل الأسماء الممكنة
        const names: string[] = []
        if (opts.media?.romajiTitle) names.push(opts.media.romajiTitle)
        if (opts.media?.englishTitle) names.push(opts.media.englishTitle)
        if (opts.query) names.push(opts.query)

        if (names.length === 0) return []

        const results: SearchResult[] = []
        const seen: { [key: string]: boolean } = {}

        for (const name of names) {
            // حول الاسم لـ slug محتمل
            const slugCandidates = this.nameToSlugCandidates(name)

            for (const slug of slugCandidates) {
                if (seen[slug]) continue
                seen[slug] = true

                // تحقق إذا الصفحة موجودة
                const exists = await this.checkSlugExists(slug)
                if (exists) {
                    results.push({
                        id: slug,
                        title: name,
                        url: `${this.api}/titles/${slug}`,
                        subOrDub: "sub",
                    })
                }
            }

            if (results.length > 0) return results
        }

        return results
    }

    // يحول الاسم لقائمة slugs محتملة
    nameToSlugCandidates(name: string): string[] {
        const base = name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s\u0600-\u06FF]/g, " ")  // احتفظ بالعربي والإنجليزي والأرقام
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")

        const candidates: string[] = [base]

        // بدائل شائعة
        const alt1 = base.replace(/no-/g, "")  // "boku-hero" بدل "boku-no-hero"
        if (alt1 !== base) candidates.push(alt1)

        // بدون كلمات زائدة
        const alt2 = base
            .replace(/-season-\d+/g, "")
            .replace(/-part-\d+/g, "")
            .replace(/-cour-\d+/g, "")
        if (alt2 !== base) candidates.push(alt2)

        return candidates
    }

    async checkSlugExists(slug: string): Promise<boolean> {
        try {
            const response = await fetch(`${this.api}/titles/${slug}`, {
                headers: {
                    "User-Agent": this.userAgent,
                    "Accept": "text/html",
                },
            })
            return response.ok && response.status === 200
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
            new RegExp(`href=["']/episode/${this.escapeRegExp(slug)}/(\\d+)["']`, "g"),
            new RegExp(`["']${this.escapeRegExp(this.api)}/episode/${this.escapeRegExp(slug)}/(\\d+)["']`, "g"),
            /href=["']\/episode\/[^"']+\/(\d+)["']/g,
        ]

        for (const pattern of patterns) {
            let match: RegExpExecArray | null
            while ((match = pattern.exec(html)) !== null) {
                const number = parseInt(match[1], 10)
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
        const playerUrl = this.extractPlayerUrl(html)

        if (!playerUrl) {
            throw new Error("Failed to find player URL for: " + episodeUrl)
        }

        return await this.extractFromPlayer(playerUrl, episodeUrl)
    }

    async extractFromPlayer(playerUrl: string, referer: string): Promise<EpisodeServer> {
        const html = await this.fetchText(playerUrl, referer)

        let sourcePayload = ""
        const patterns = [
            /var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/g,
            /sources\s*[:=]\s*(\[[\s\S]*?\])/g,
            /file_sources\s*[:=]\s*(\[[\s\S]*?\])/g,
        ]

        for (const pattern of patterns) {
            let m: RegExpExecArray | null
            while ((m = pattern.exec(html)) !== null) {
                if (m[1] && m[1] !== "[]") sourcePayload = m[1]
            }
            if (sourcePayload) break
        }

        if (!sourcePayload) {
            throw new Error("Failed to find video sources at: " + playerUrl)
        }

        const sources = JSON.parse(sourcePayload) as Anime3rbVideoSource[]
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

    async fetchText(url: string, referer: string): Promise<string> {
        const response = await fetch(url, {
            headers: {
                "User-Agent": this.userAgent,
                "Referer": referer,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
                "Accept-Encoding": "gzip, deflate, br",
                "Connection": "keep-alive",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "same-origin",
                "Cache-Control": "max-age=0",
            },
        })

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} — ${url}`)
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
            if (m && m[1]) return m[1].replace(/\\\//g, "/")
            if (m && m[0] && !m[1]) return m[0].replace(/\\\//g, "/")
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