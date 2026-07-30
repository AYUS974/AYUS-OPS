import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.NOTES_FILE = path.join(os.tmpdir(), `ayus-notes-test-${Date.now()}.json`);
const { saveNote, appendNote, listNotes, listProjects, deleteNote } = await import("./src/lib/notes.js");

const a = await saveNote({ title: "UTMS telemetry", body: "MAVLink over UDP", project: "utms", tags: ["drone"] });
await saveNote({ title: "Ops billing idea", body: "usage-based", project: "ayus-ops" });

assert.equal((await listNotes()).length, 2);
assert.equal((await listNotes({ project: "utms" })).length, 1, "project filter");
assert.equal((await listNotes({ q: "mavlink" })).length, 1, "body search is case-insensitive");
assert.equal((await listNotes({ q: "drone" })).length, 1, "tags are searchable");
assert.deepEqual(await listProjects(), ["ayus-ops", "utms"]);

// Same title appends instead of creating a second note — the ongoing-log case.
const appended = await appendNote({ title: "UTMS telemetry", body: "also: 1Hz heartbeat", source: "ayus" });
assert.equal(appended.id, a.id, "append reuses the note");
assert.equal((await listNotes()).length, 2, "no duplicate created");
assert.match(appended.body, /MAVLink over UDP[\s\S]*1Hz heartbeat/, "old body kept, new text after it");
assert.equal(appended.project, "utms", "append keeps the project when none is passed");

const fresh = await appendNote({ title: "Brand new", body: "x" });
assert.equal((await listNotes()).length, 3, "append creates when the title is new");

await assert.rejects(() => saveNote({ title: "  ", body: "x" }), /title is required/);
await deleteNote(fresh.id);
assert.equal((await listNotes()).length, 2);

await fs.rm(process.env.NOTES_FILE, { force: true });
console.log("notes: all checks passed");
