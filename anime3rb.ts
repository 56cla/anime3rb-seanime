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
        const query = (opts.query || opts.media.romajiTitle || opts.media.englishTitle || "").trim()
        if (!query) return []

        const html = await this.fetchText(
            `${this.api}/titles/list?q=${encodeURIComponent(query)}`,
            this.api + "/"
        )

        const results: SearchResult[] = []
        const seen: { [key: string]: boolean } = {}

        // استخراج slugs عبر regex بدل LoadDoc لأن الموقع قد يكون dynamic
        const slugRegex = /href="\/titles\/([^"/?#]+)"/g
        const titleRegex = /class="[^"]*(?:title|name)[^"]*"[^>]*>([^<]{2,80})</g
        const imgRegex = /href="\/titles\/[^"]+"\s[^>]*>\s*<img[^>]+src="([^"]+)"/g

        const slugs: string[] = []
        let m: RegExpExecArray | null

        while ((m = slugRegex.exec(html)) !== null) {
            const slug = m[1].trim()
            if (slug && slug !== "list" && !seen[slug]) {
                seen[slug] = true
                slugs.push(slug)
            }
        }

        // محاولة مطابقة العناوين مع الـ slugs
        const titles: string[] = []
        while ((m = titleRegex.exec(html)) !== null) {
            const t = this.cleanTitle(m[1])
            if (t && t.length > 1) titles.push(t)
        }

        for (let i = 0; i < slugs.length && i < 25; i++) {
            const slug = slugs[i]
            results.push({
                id: slug,
                title: titles[i] || this.titleFromSlug(slug),
                url: `${this.api}/titles/${slug}`,
                subOrDub: "sub",
            })
        }

        // fallback: جرب LoadDoc إذا regex ما أعطى نتائج
        if (results.length === 0) {
            try {
                const $ = LoadDoc(html)
                $("a[href*='/titles/']").each((_, el) => {
                    const href = $(el).attr("href") || ""
                    const slug = this.titleSlugFromUrl(this.absoluteUrl(href))
                    if (!slug || slug === "list" || seen[slug]) return
                    const title = this.cleanTitle(
                        $(el).find(".title-name, h2, h3").first().text() || $(el).text()
                    )
                    if (!title || title.length < 2) return
                    seen[slug] = true
                    results.push({
                        id: slug,
                        title,
                        url: `${this.api}/titles/${slug}`,
                        subOrDub: "sub",
                    })
                })
            } catch (_) {}
        }

        return results.slice(0, 25)
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const slug = this.titleSlugFromUrl(id) || id
        const html = await this.fetchText(
            `${this.api}/titles/${slug}`,
            `${this.api}/titles/${slug}`
        )

        const episodesByNumber: { [key: string]: EpisodeDetails } = {}

        // regex يمسك: /episode/{slug}/{number}
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

        // fallback: URL كاملة
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
        const episodeHtml = await this.fetchText(episodeUrl, `${this.api}/`)
        const playerUrl = this.extractPlayerUrl(episodeHtml)

        if (!playerUrl) {
            throw new Error("Failed to find player URL for episode: " + episodeUrl)
        }

        const playerHtml = await this.fetchText(playerUrl, episodeUrl)

        // محاولة استخراج video_sources
        const sourceRegexp = /var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/g
        let sourceMatch: RegExpExecArray | null
        let sourcePayload = ""

        while ((sourceMatch = sourceRegexp.exec(playerHtml)) !== null) {
            if (sourceMatch[1] && sourceMatch[1] !== "[]") {
                sourcePayload = sourceMatch[1]
            }
        }

        // fallback: ابحث عن array مباشرة
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
                Referer: referer,
                "User-Agent": this.userAgent,
                "Accept-Language": "ar,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
        })

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} — ${url}`)
        }

        return response.text()
    }

    extractPlayerUrl(html: string): string {
        const decoded = this.decodeHtml(html)

        // محاولة 1: JSON مضمن {"video_url":"..."}
        const jsonMatch = decoded.match(/"video_url"\s*:\s*"(https?:[^"]+)"/)
        if (jsonMatch && jsonMatch[1]) {
            return jsonMatch[1].replace(/\\\//g, "/")
        }

        // محاولة 2: رابط vid3rb مباشرة (escaped أو عادي)
        const vid3rbMatch = decoded.match(/https?:\\?\/\\?\/video\.vid3rb\.com\\?\/player\\?\/[^"'\s<>]+/)
        if (vid3rbMatch && vid3rbMatch[0]) {
            return vid3rbMatch[0].replace(/\\\//g, "/")
        }

        // محاولة 3: أي iframe src
        const iframeMatch = decoded.match(/iframe[^>]+src=["'](https?:\/\/[^"']+)["']/)
        if (iframeMatch && iframeMatch[1]) {
            return iframeMatch[1]
        }

        // محاولة 4: data-src أو data-url
        const dataMatch = decoded.match(/data-(?:src|url)=["'](https?:\/\/[^"']+)["']/)
        if (dataMatch && dataMatch[1]) {
            return dataMatch[1]
        }

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