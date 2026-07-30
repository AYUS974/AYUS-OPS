---
aliases: [Components, React Components]
tags: [frontend, components]
created: 2026-07-22
---

# 🧩 UI Components

All React components live in `web/src/components/`.

---

## Component Map

| Component | File | Size | Purpose |
|-----------|------|------|---------|
| **Dashboard** | `Dashboard.jsx` | 57 KB | Main UI — tabs, approval queue, stats, integrations |
| **Login** | `Login.jsx` | 2.2 KB | Supabase Auth login form |
| **AyusReactor** | `AyusReactor.jsx` | 22 KB | AYUS chat + voice interface |
| **CodeWorkspace** | `CodeWorkspace.jsx` | 8 KB | In-app code editor |
| **LeadPipeline** | `LeadPipeline.jsx` | 7 KB | Visual lead funnel/pipeline |
| **MissionControl** | `MissionControl.jsx` | 19 KB | Mission builder (multi-step projects) |
| **Workflows** | `Workflows.jsx` | 20 KB | Visual workflow automation builder |

---

## Styling

All styles are in `web/src/index.css` (~63 KB) — a complete custom design system:
- Dark theme with glassmorphism
- No CSS framework (no Tailwind)
- Custom properties for theming
- Responsive layouts
- Per-component styles (`.ayus-reactor`, `.lead-pipeline`, etc.)

Additional component-specific CSS files:
- `AyusReactor.css` (6 KB)
- `CodeWorkspace.css` (3.3 KB)
- `LeadPipeline.css` (5.5 KB)
- `MissionControl.css` (21 KB)
- `Workflows.css` (11 KB)

---

## Related

- [[Dashboard]]
- [[AYUS Chat Interface]]
