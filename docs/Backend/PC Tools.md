---
aliases: [Laptop Access, PC Access, File Access]
tags: [backend, ayus, tools]
created: 2026-07-22
---

# 💻 PC Tools — AYUS's Laptop Access

> **File:** `src/lib/pc-tools.js` (16 KB)
> Guarded, read-only access to your computer.

---

## What AYUS Can Do

| Tool | Description | Safety |
|------|-------------|--------|
| **Open app** | Launch applications (Spotify, Chrome, VS Code, etc.) | ✅ Safe |
| **Play music** | `"play some Arijit Singh on Spotify"` | ✅ Safe |
| **Open website** | Opens URL in default browser | ✅ Safe |
| **Search files** | Find files by name/pattern | 🔒 Only in `PC_ALLOWED_DIRS` |
| **Read files** | Read file contents | 🔒 Only in `PC_ALLOWED_DIRS` |
| **Open file** | Open a file with its default app | 🔒 Only in `PC_ALLOWED_DIRS` |

---

## What AYUS CANNOT Do

> [!caution] Hard Safety Boundary
> These tools **do not exist** in AYUS's toolkit. Not disabled — literally not defined:
> - ❌ Delete files
> - ❌ Modify/edit files
> - ❌ Move/rename files
> - ❌ Install software
> - ❌ Run arbitrary commands
> - ❌ Access files outside allowed directories

---

## Configuration

Set `PC_ALLOWED_DIRS` in `.env` to control which folders AYUS can see:

```env
# Semicolon-separated. AYUS can only read/search/open inside these.
PC_ALLOWED_DIRS=F:\AYUS Labs;C:\Users\you\Desktop;C:\Users\you\Downloads;C:\Users\you\Documents
```

---

## Related

- [[AYUS — Secretary Agent]]
- [[Environment Variables]]
