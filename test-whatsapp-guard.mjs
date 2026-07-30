// Guard check: AYUS must not WhatsApp anyone on its own initiative, and must
// never dial a number the founder did not give. Run: node test-whatsapp-guard.mjs
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

process.env.CONTACTS_FILE = fileURLToPath(new URL("./data/contacts.json", import.meta.url));
const { execTool } = await import("./src/lib/secretaryAgent.js");


const send = (args, lastUser) => execTool("whatsapp_send", args, { lastUser }).then((r) => r.result);

// Unprompted send — the actual incident: nobody asked, AYUS texted an intern.
let r = await send({ name: "Pravesh", message: "Hey Arjun, got the report on MQTT." }, "aaj ka schedule kya hai?");
assert.equal(r.ok, false, "unprompted send must be refused");
assert.match(r.error, /did not ask/);

// Invented number, even with a real ask.
r = await send({ phone: "919960094460", message: "hi" }, "Arjun ko message bhej do");
assert.equal(r.ok, false, "made-up number must be refused");
assert.match(r.error, /never invent/);

// Number the founder actually dictated passes the guard (fails later at the
// disconnected socket, which is the point — it got past the check).
r = await send({ phone: "9021793584", message: "hi" }, "9021793584 pe message bhej do").catch((e) => e);
assert.ok(!(r?.ok === false && /never invent/.test(r.error)), "dictated number must pass");

// Unknown name with a real ask: asks instead of guessing.
r = await send({ name: "Arjun", message: "hi" }, "Arjun ko bol do report mil gayi");
assert.equal(r.ok, false);
assert.match(r.error, /no contact named/);

// "mujhe bhej do" goes to the founder's own number, country code added — a
// 10-digit .env entry never matched the jid before, so nobody got a reply.
process.env.FOUNDER_NUMBER = "8208795203";
const { findContact, founderPhone } = await import("./src/lib/contacts.js");
assert.equal(founderPhone(), "918208795203");
for (const word of ["me", "mujhe", "mereko", "khud"]) {
  const self = await findContact(word);
  assert.equal(self.ok, true, `"${word}" must resolve to the founder`);
  assert.equal(self.contact.phone, "918208795203");
}

console.log("ok — whatsapp guards hold");
