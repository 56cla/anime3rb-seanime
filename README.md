# Anime3rb SeAnime Extension

This is an online streaming provider extension for SeAnime (v0.6.0).

Files:
- `anime3rb.ts`: provider source code.
- `anime3rb.json`: generated manifest with the provider payload embedded.

To test it, open SeAnime, go to Extensions, open Playground, select `Online Streaming Provider`, and paste the contents of `anime3rb.ts`.

To install it locally, place `anime3rb.json` in SeAnime's `extensions` data directory.

## v0.6.0 Changes
### Search
- Added Livewire search endpoint attempt for faster results
- Added accent normalization (e, u, n -> e, u, n etc.)
- Added Japanese stop-word stripping (no, to, wa, ga...)
- Added parenthetical suffix stripping ((TV), (2024), (Dub))
- Returns all matching slugs instead of stopping at first match
- 404 detection checks for Arabic "not found" page text

### Episode Detection
- Episode regex uses case-insensitive flag
- Broad fallback pattern captures slug+number when main slug matches miss

### Video Player
- Added JSON-LD embedUrl extraction (most reliable, server-rendered)
- Relative player URLs are resolved to absolute
- Multiple fallback approaches for source extraction
- Added vid3rb API endpoint attempt (`/api/sources/{uuid}`)
- Removed Accept-Encoding header to avoid decompression issues
- &amp; entities decoded in extracted URLs

