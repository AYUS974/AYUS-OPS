# ⚡ Workflow Studio

A **standalone, portable** workflow-automation app — the n8n idea, stripped to a
single self-contained folder you can lift out and deploy anywhere Node runs.

A **workflow** = a **trigger** + an ordered list of **steps**. When the trigger
fires, the engine runs the steps top-to-bottom, threading each step's output
into the next.

- **No database, no accounts, no build step.** State is plain JSON files under
  `./data`. The UI is one static HTML page. Two npm deps (`express`,
  `node-cron`).
- Runs fully **offline** — every step type except `http`/`llm` needs zero
  network.

## Run

```bash
npm install
npm start          # → http://localhost:4100
```

Set a different port with `PORT=8080 npm start`. Run the engine self-check with
`npm test`.

## Triggers

| Type       | Fires when… |
|------------|-------------|
| `manual`   | you click **Run now** (or `POST /api/workflows/:id/run`) |
| `schedule` | a cron expression matches (e.g. `0 9 * * *` = 9am daily) |
| `event`    | someone `POST`s to the workflow's webhook URL — `POST /hook/<token>`. The request body becomes `{{trigger.payload}}`. |

## Steps

| Step        | What it does |
|-------------|--------------|
| `template`  | Compose text from a template → its output |
| `set`       | Store a value in `{{vars.<key>}}` |
| `http`      | Call any external API (GET/POST/…); output `{ status, ok, body }` |
| `condition` | Gate: stop the run cleanly unless a comparison passes |
| `delay`     | Wait N seconds (max 300) |
| `log`       | Print a line to the console + run log |
| `llm`       | Optional — one Anthropic call; needs `ANTHROPIC_API_KEY` in the env |

## Templating

Any config string can reference earlier data with `{{ … }}`:

- `{{trigger.payload.email}}` — the webhook/run payload
- `{{steps.s1.output}}` — a previous step's output (whole object if used alone)
- `{{vars.greeting}}` — a value set by a `set` step

A string that is **exactly** one reference returns the raw value (objects
survive); references inside other text are stringified and spliced in.

## Deploy to production

It's just a Node app — move this folder anywhere and run `npm install && npm start`.
No auth is built in (it's meant to sit behind your own trust boundary); put it
behind a reverse-proxy auth or a private network if you expose it publicly.
Event workflows are still gated by their per-workflow webhook token.

## Layout

```
server.js          REST API + static UI + cron
engine.js          step handlers + template resolver + runner
store.js           JSON-file persistence (./data)
public/index.html  the UI shell (inline CSS)
public/app.js      the UI logic (vanilla, no framework)
test.js            engine self-check (npm test)
```
