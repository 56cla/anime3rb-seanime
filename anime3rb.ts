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

        const html = await this.fetchText(`${this.api}/titles/list?q=${encodeURIComponent(query)}`, this.api + "/")
        const $ = LoadDoc(html)
        const results: SearchResult[] = []
        const seen: { [key: string]: boolean } = {}

        $("a").each((_, el) => {
            const href = this.absoluteUrl($(el).attr("href") || "")
            const slug = this.titleSlugFromUrl(href)
            if (!slug || seen[slug]) return

            const title = this.cleanTitle(
                $(el).find(".title-name").text()
                || $(el).find("h2").text()
                || $(el).text()
                || $(el).attr("title")
            )

            if (!title || slug === "list") return

            seen[slug] = true
            results.push({
                id: slug,
                title,
                url: `${this.api}/titles/${slug}`,
                subOrDub: "sub",
            })
        })

        return results.slice(0, 25)
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const slug = this.titleSlugFromUrl(id) || id
        const html = await this.fetchText(`${this.api}/titles/${slug}`, `${this.api}/titles/${slug}`)
        const episodesByNumber: { [key: string]: EpisodeDetails } = {}
        const regexp = new RegExp(`${this.escapeRegExp(this.api)}/episode/${this.escapeRegExp(slug)}/(\\d+)`, "g")
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

        const episodes = Object.keys(episodesByNumber)
            .map((key) => episodesByNumber[key])
            .sort((a, b) => a.number - b.number)

        if (episodes.length === 0) {
            throw new Error("No episodes found.")
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
            throw new Error("Failed to find Anime3rb player URL.")
        }

        const playerHtml = await this.fetchText(playerUrl, episodeUrl)
        const sourceRegexp = /var\s+video_sources\s*=\s*(\[[\s\S]*?\]);/g
        let sourceMatch: RegExpExecArray | null
        let sourcePayload = ""

        while ((sourceMatch = sourceRegexp.exec(playerHtml)) !== null) {
            if (sourceMatch[1] && sourceMatch[1] !== "[]") {
                sourcePayload = sourceMatch[1]
            }
        }

        if (!sourcePayload) {
            throw new Error("Failed to find Anime3rb video sources.")
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
            throw new Error("No playable Anime3rb sources found.")
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
            },
        })

        if (!response.ok) {
            throw new Error(`Request failed: ${response.status} ${url}`)
        }

        return response.text()
    }

    extractPlayerUrl(html: string): string {
        const decoded = this.decodeHtml(html)
        const jsonMatch = decoded.match(/"video_url":"([^"]+)"/)
        if (jsonMatch && jsonMatch[1]) {
            return jsonMatch[1].replace(/\\\//g, "/")
        }

        const urlMatch = decoded.match(/https:\\\/\\\/video\.vid3rb\.com\\\/player\\\/[^"<]+/)
        if (urlMatch && urlMatch[0]) {
            return urlMatch[0].replace(/\\\//g, "/")
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
