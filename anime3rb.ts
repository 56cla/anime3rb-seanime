/// <reference path="./online-streaming-provider.d.ts" />

type Anime3rbVideoSource = {
    src: string
    type: string
    label: string
    res: string
    premium: boolean
}

type Anime3rbSearchItem = {
    slug: string
    name: string
    name_en: string
    poster: string
    type: string
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
        const query = (opts.query || opts.media.romajiTitle || opts.media.englishTitle || "").trim()
        if (!query) return []

        // جرب الـ API الداخلي أولاً (أسرع وأقل عرضة للبلوك)
        try {
            const apiRes = await this.fetchText(
                `${this.api}/api/search?q=${encodeURIComponent(query)}`,
                this.api + "/"
            )
            const data = JSON.parse(apiRes)
            const items: Anime3rbSearchItem[] = data.data || data.results || data || []

            if (Array.isArray(items) && items.length > 0) {
                return items.slice(0, 25).map((item) => ({
                    id: item.slug,
                    title: item.name || item.name_en || this.titleFromSlug(item.slug),
                    url: `${this.api}/titles/${item.slug}`,
                    subOrDub: "sub",
                }))
            }
        } catch (_) {}

        // fallback: جرب endpoint ثاني
        try {
            const apiRes2 = await this.fetchText(
                `${this.api}/api/titles?search=${encodeURIComponent(query)}`,
                this.api + "/"
            )
            const data2 = JSON.parse(apiRes2)
            const items2: Anime3rbSearchItem[] = data2.data || data2 || []

            if (Array.isArray(items2) && items2.length > 0) {
                return items2.slice(0, 25).map((item) => ({
                    id: item.slug,
                    title: item.name || item.name_en || this.titleFromSlug(item.slug),
                    url: `${this.api}/titles/${item.slug}`,
                    subOrDub: "sub",
                }))
            }
        } catch (_) {}

        // fallback أخير: HTML scraping
        try {
            const html = await this.fetchText(
                `${this.api}/titles/list?q=${encodeURIComponent(query)}`,
                this.api + "/"
            )
            const results: SearchResult[] = []
            const seen: { [key: string]: boolean } = {}
            const slugRegex = /href="\/titles\/([^"/?#]+)"/g
            let m: RegExpExecArray | null

            while ((m = slugRegex.exec(html)) !== null) {
                const slug = m[1].trim()
                if (slug && slug !== "list" && !seen[slug]) {
                    seen[slug] = true
                    results.push({
                        id: slug,
                        title: this.titleFromSlug(slug),
                        url: `${this.api}/titles/${slug}`,
                        subOrDub: "sub",
                    })
                }
            }
            return results.slice(0, 25)
        } catch (_) {}

        return []
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const slug = this.titleSlugFromUrl(id) || id

        // جرب API أولاً
        try {
            const apiRes = await this.fetchText(
                `${this.api}/api/titles/${slug}/episodes`,
                `${this.api}/titles/${slug}`
            )
            const data = JSON.parse(apiRes)
            const items = data.data || data.episodes || data || []

            if (Array.isArray(items) && items.length > 0) {
                return items
                    .map((ep: any) => ({
                        id: `${slug}/${ep.number || ep.episode_number || ep.num}`,
                        number: parseInt(ep.number || ep.episode_number || ep.num, 10),
                        title: ep.title || ep.name || `Episode ${ep.number || ep.num}`,
                        url: `${this.api}/episode/${slug}/${ep.number || ep.episode_number || ep.num}`,
                    }))
                    .sort((a: EpisodeDetails, b: EpisodeDetails) => a.number - b.number)
            }
        } catch (_) {}

        // fallback: HTML scraping
        const html = await this.fetchText(
            `${this.api}/titles/${slug}`,
            `${this.api}/titles/${slug}`
        )

        const episodesByNumber: { [key: string]: EpisodeDetails } = {}

        const regexp = new RegExp(
            `href=["']/episode/${this.escapeRegExp(slug)}/(\\d+)["']`,
            "g"
        )
        let match: RegExpExecArray | null

        while ((match = regexp.exec(html)) !== null) {
            const number = parseInt(match[1], 10)
            if (!number || episodesByNumber[String(number)]) continue
            episodesByNumber[String(number)] = {
                id: `${slug}/${number}`,
                number,
                title: `Episode ${number}`,
                url: `${this.api}/episode/${slug}/${number}`,
            }
        }

        // fallback 2: URL كاملة
        if (Object.keys(episodesByNumber).length === 0) {
            const fullRegexp = new RegExp(
                `${this.escapeRegExp(this.api)}/episode/${this.escapeRegExp(slug)}/(\\d+)`,
                "g"
            )
            while ((match = fullRegexp.exec(html)) !== null) {
                const number = parseInt(match[1], 10)
                if (!number || episodesByNumber[String(number)]) continue
                episodesByNumber[String(number)] = {
                    id: `${slug}/${number}`,
                    number,
                    title: `Episode ${number}`,
                    url: `${this.api}/episode/${slug}/${number}`,
                }
            }
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

        // جرب API للحصول على player URL مباشرة
        const slugAndNum = episodePath.split("/")
        const slug = slugAndNum[0]
        const num = slugAndNum[1]

        try {
            const apiRes = await this.fetchText(
                `${this.api}/api/titles/${slug}/episodes/${num}`,
                episodeUrl
            )
            const data = JSON.parse(apiRes)
            const playerUrl = data.video_url || data.embed_url || data.player_url || ""

            if (playerUrl) {
                return await this.extractFromPlayer(playerUrl, episodeUrl)
            }
        } catch (_) {}

        // fallback: scrape صفحة الحلقة
        const episodeHtml = await this.fetchText(episodeUrl, `${this.api}/`)
        const playerUrl = this.extractPlayerUrl(episodeHtml)

        if (!playerUrl) {
            throw new Error("Failed to find player URL for: " + episodeUrl)
        }

        return await this.extractFromPlayer(playerUrl, episodeUrl)
    }

    async extractFromPlayer(playerUrl: string, referer: string): Promise<EpisodeServer> {
        const playerHtml = await this.fetchText(playerUrl, referer)

        const sourceRegexp = /var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/g
        let sourceMatch: RegExpExecArray | null
        let sourcePayload = ""

        while ((sourceMatch = sourceRegexp.exec(playerHtml)) !== null) {
            if (sourceMatch[1] && sourceMatch[1] !== "[]") {
                sourcePayload = sourceMatch[1]
            }
        }

        if (!sourcePayload) {
            const altMatch = playerHtml.match(/sources\s*[:=]\s*(\[[\s\S]*?\])/)
            if (altMatch) sourcePayload = altMatch[1]
        }

        if (!sourcePayload) {
            throw new Error("Failed to find video sources at: " + playerUrl)
        }

        let sources: Anime3rbVideoSource[] = []
        try {
            sources = JSON.parse(sourcePayload) as Anime3rbVideoSource[]
        } catch (_) {
            throw new Error("Failed to parse video sources JSON.")
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

    async fetchText(url: string, referer: string): Promise<string> {
        const response = await fetch(url, {
            headers: {
                "User-Agent": this.userAgent,
                "Referer": referer,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "ar,en-US;q=0.9,en;q=0.8",
                "Accept-Encoding": "gzip, deflate, br",
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1",
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

        const jsonMatch = decoded.match(/"video_url"\s*:\s*"(https?:[^"]+)"/)
        if (jsonMatch && jsonMatch[1]) return jsonMatch[1].replace(/\\\//g, "/")

        const vid3rbMatch = decoded.match(/https?:\\?\/\\?\/video\.vid3rb\.com\\?\/player\\?\/[^"'\s<>]+/)
        if (vid3rbMatch && vid3rbMatch[0]) return vid3rbMatch[0].replace(/\\\//g, "/")

        const iframeMatch = decoded.match(/iframe[^>]+src=["'](https?:\/\/[^"']+)["']/)
        if (iframeMatch && iframeMatch[1]) return iframeMatch[1]

        const dataMatch = decoded.match(/data-(?:src|url|embed)=["'](https?:\/\/[^"']+)["']/)
        if (dataMatch && dataMatch[1]) return dataMatch[1]

        return ""
    }

    absoluteUrl(url: string): string {
        if (!url) return ""
        if (url.indexOf("http") === 0) return url
        if (url.indexOf("//") === 0) return "https:" + url
        if (url.charAt(0) === "/") return this.api + url
        return `${this.api}/${url}`
    }

    titleSlugFromUrl(url: string): string {
        const match = url.match(/\/titles\/([^?#/]+)/)
        return match && match[1] ? match[1] : ""
    }

    titleFromSlug(slug: string): string {
        return slug
            .split("-")
            .map((part) => part ? part.charAt(0).toUpperCase() + part.slice(1) : part)
            .join(" ")
    }

    cleanTitle(value: string): string {
        return this.decodeHtml(value || "")
            .replace(/\s+/g, " ")
            .trim()
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