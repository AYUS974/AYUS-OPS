import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.TRANSCRIPT_FILE = path.join(os.tmpdir(), `ayus-transcript-test-${Date.now()}.jsonl`);
const { logTurn, recallTurns, conversationBlock } = await import("./src/lib/transcript.js");

assert.deepEqual(await recallTurns("anything"), [], "no file yet = no memory, not a crash");

await logTurn({
  surface: "voice",
  user: "Arjun ko bol do fire radiation pe research kare",
  reply: "Delegated to Arjun, sir.",
  tools: ["delegate_to_researcher(fire radiation) → ✓"],
});
await logTurn({ user: "invoice bhej do Sharma ko", reply: "Queued for your approval." });
await logTurn({ user: "volume kam karo", reply: "Done." });

// The reproduction: a task delegated in an earlier session, never note_save'd.
const hits = await recallTurns("Arjun ka fire radiation task report kya hua");
assert.ok(
  hits.some((t) => /fire radiation/.test(t.user)),
  "delegated task is recalled from the transcript"
);

// Tool events are searchable too — the answer text alone was vague.
assert.ok(
  (await recallTurns("delegate_to_researcher")).some((t) => t.surface === "voice"),
  "tool events are part of the haystack"
);

// A question with no keywords still gets the recent turns back.
const vague = await recallTurns("kal kya bola tha", { recent: 2 });
assert.equal(vague.length, 2, "recency floor covers keyword-less questions");
assert.ok(
  vague.every((t, i, a) => i === 0 || String(a[i - 1].at) <= String(t.at)),
  "returned oldest-first so the model reads them in order"
);

// Stopwords must not match everything.
assert.equal((await recallTurns("kya hai", { recent: 0 })).length, 0, "stopwords score nothing");

// What is already in the live message list isn't paid for twice.
const deduped = await recallTurns("volume", { recent: 0, exclude: ["volume kam karo"] });
assert.equal(deduped.length, 0, "exclude drops turns already in context");

const block = await conversationBlock("fire radiation");
assert.match(block, /EARLIER CONVERSATIONS/);
assert.match(block, /fire radiation/);
assert.equal(await conversationBlock("", { recent: 0 }), "", "nothing to recall = empty block");

// A truncated write must not take the whole memory down with it.
await fs.appendFile(process.env.TRANSCRIPT_FILE, '{"at":"2026-01-01T00:00:00Z","user":"half\n');
assert.ok((await recallTurns("fire radiation")).length > 0, "bad line skipped, rest still readable");

await logTurn({ user: "", reply: "" });
await fs.rm(process.env.TRANSCRIPT_FILE, { force: true });
console.log("transcript: all checks passed");
