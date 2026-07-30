---
aliases: [Home, AYUS, Index]
tags: [home, moc]
created: 2026-07-22
---

# 🏠 AYUS Ops — Knowledge Base

> **AI-run operations system for AYUS Labs.** Agents handle sales, finance, marketing, HR & tech — every action they want to take lands in an approval queue, and nothing executes until you approve it.

---

## 🗺️ Navigation

### 📐 Architecture
- [[Architecture Overview]] — How the whole system fits together
- [[Tech Stack]] — Every technology used, and why
- [[Project Structure]] — File & folder map

### 🤖 AI Agents
- [[Agents Overview]] — All 7 agents at a glance
- [[Arjun — Sales Agent]]
- [[Meera — Finance Agent]]
- [[Kabir — Marketing Agent]]
- [[Isha — HR Agent]]
- [[Vikram — CTO Agent]]
- [[AYUS — Secretary Agent]] — The JARVIS-style assistant
- [[Researcher Agent]]

### 🗄️ Database
- [[Database Schema]] — All Supabase tables
- [[Pending Actions]] — The approval queue (core table)
- [[Data Flow]] — How data moves through the system

### 🌐 Frontend
- [[Dashboard]] — React (Vite) UI overview
- [[UI Components]] — All dashboard components
- [[AYUS Chat Interface]] — Voice + text assistant UI

### ⚙️ Backend
- [[Server (index.js)]] — Express app, routes, middleware
- [[Orchestrator]] — Daily cron + agent runner
- [[LLM Abstraction]] — Multi-provider AI layer
- [[Executor]] — What happens when you approve an action
- [[PC Tools]] — AYUS's laptop access (guarded)

### 🔌 Integrations
- [[Google Integration]] — Gmail + Calendar
- [[Spotify Integration]] — Music playback
- [[Email (Resend)]] — Transactional email
- [[Telegram Notifications]]
- [[Voice System]] — TTS providers (Sarvam, Cartesia, ElevenLabs)

### 🖥️ Desktop App
- [[Desktop App (Electron)]] — JARVIS-style shell
- [[Overlay Widget]] — Floating assistant pill

### 🚀 Deployment
- [[Setup Guide]] — Get running in 20 minutes
- [[Environment Variables]] — Every .env key explained
- [[Render Deployment]] — One-click cloud deploy
- [[Docker]] — Container build

---

## 🏢 The Company (Agent Seats)

| Seat | Agent | Role |
|------|-------|------|
| ★ CEO | **You** | Final approval on everything |
| Sales | **[[Arjun — Sales Agent\|Arjun]]** | Qualifies leads, drafts follow-ups |
| Finance | **[[Meera — Finance Agent\|Meera]]** | Chases invoices, flags payment risk |
| Marketing | **[[Kabir — Marketing Agent\|Kabir]]** | Reviews content, writes hooks |
| HR | **[[Isha — HR Agent\|Isha]]** | Screens candidates, schedules interviews |
| CTO | **[[Vikram — CTO Agent\|Vikram]]** | Triages bugs & ideas by priority |
| Secretary | **[[AYUS — Secretary Agent\|AYUS]]** | JARVIS-style ops intelligence |

---

## 🔑 Core Principle

> [!important] Agents Never Act Directly
> Every agent writes proposals into [[Pending Actions]]. The [[Dashboard]] shows them. Approving executes them via the [[Executor]]. **You are always in control.**

---

## 📊 Quick Stats

- **7 AI agents** running daily
- **4 LLM providers** supported (Anthropic, Gemini, Groq, GLM)
- **3 voice providers** (Sarvam, Cartesia, ElevenLabs) + free browser voices
- **10 database tables** in Supabase
- **12 action types** the executor handles
- **Desktop + Web** — same app, both modes
