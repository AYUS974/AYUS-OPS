import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.CONTACTS_FILE = path.join(os.tmpdir(), `ayus-contacts-test-${Date.now()}.json`);
const { normalizePhone, saveContact, listContacts, findContact, deleteContact } = await import("./src/lib/contacts.js");

assert.equal(normalizePhone("98765 43210"), "919876543210", "bare 10 digits get +91");
assert.equal(normalizePhone("+1 (415) 555-0123"), "14155550123", "full number kept as-is");

const rahul = await saveContact({ name: "Rahul Sharma", phone: "9876543210", note: "client" });
await saveContact({ name: "Rahul Verma", phone: "9812345678" });
await saveContact({ name: "Priya", phone: "919999988888" });

assert.equal((await listContacts()).length, 3);
assert.equal((await findContact("priya")).contact.phone, "919999988888", "case-insensitive match");
assert.equal((await findContact("Rahul Sharma")).contact.id, rahul.id, "exact name beats the other Rahul");

const ambiguous = await findContact("Rahul");
assert.equal(ambiguous.ok, false, "two Rahuls must not auto-pick one");
assert.deepEqual(ambiguous.ambiguous.sort(), ["Rahul Sharma", "Rahul Verma"]);

assert.equal((await findContact("Nobody")).ok, false);
await assert.rejects(() => saveContact({ name: "Bad", phone: "12" }), /invalid/);

const edited = await saveContact({ id: rahul.id, name: "Rahul S", phone: "9876543210" });
assert.equal(edited.id, rahul.id, "same id = update, not duplicate");
assert.equal((await listContacts()).length, 3);

await deleteContact(rahul.id);
assert.equal((await listContacts()).length, 2);

await fs.rm(process.env.CONTACTS_FILE, { force: true });
console.log("contacts: all checks passed");
