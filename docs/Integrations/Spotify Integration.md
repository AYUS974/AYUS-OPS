---
aliases: [Spotify, Music]
tags: [integration, spotify]
created: 2026-07-22
---

# 🎵 Spotify Integration

> **File:** `src/lib/spotify.js` (9.8 KB)

---

## Setup

1. Go to [developer.spotify.com](https://developer.spotify.com) → Create App
2. Copy Client ID & Secret
3. Add redirect URI: `http://127.0.0.1:3000/api/spotify/callback`
4. Set in `.env`:

```env
SPOTIFY_CLIENT_ID=your-client-id
SPOTIFY_CLIENT_SECRET=your-client-secret
```

5. In dashboard sidebar → click **"Connect Spotify"**

> [!warning] Important
> Spotify forces `127.0.0.1` (not `localhost`). Open the dashboard at `http://127.0.0.1:3000` for Spotify to work. Premium account required for playback.

---

## What AYUS Can Do

| Command | What happens |
|---------|-------------|
| "Play some Arijit Singh" | Searches + plays on Spotify |
| "Play lo-fi beats" | Searches + plays playlist |
| "Next song" | Skips to next track |
| "Pause" | Pauses playback |

---

## Related

- [[AYUS — Secretary Agent]] — Uses Spotify via chat
- [[PC Tools]] — App launching
- [[Environment Variables]]
