// Contact book — name → phone number, so AYUS can "message Rahul" instead of
// being handed 12 digits every time.
//
// Stored as a JSON file next to the server rather than a Supabase table: it is a
// short personal list that only matters on the machine the WhatsApp bot is
// paired to, the numbers never leave the laptop, and there is no SQL migration
// to run before the Contacts page works.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = process.env.CONTACTS_FILE || path.join(__dirname, "..", "..", "data", "contacts.json");

async function readAll() {
  try {
    const parsed = JSON.parse(await fs.readFile(FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return []; // nothing saved yet
    throw err;
  }
}

// ponytail: read-modify-write with no lock. One founder clicking one dashboard
// can't race himself; add a lock if contacts ever get written by an agent loop.
async function writeAll(list) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(list, null, 2));
}

/**
 * WhatsApp addresses everyone by full international number, digits only. A bare
 * 10-digit number is a local one, so prefix the country code (India by default —
 * override with WHATSAPP_COUNTRY_CODE).
 */
export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  const cc = String(process.env.WHATSAPP_COUNTRY_CODE || "91").replace(/\D/g, "");
  return digits.length === 10 ? cc + digits : digits;
}

/** The founder's own WhatsApp number — who "mujhe bhej do" means, and the one
 * number whose messages reach the real brain instead of the receptionist. */
export function founderPhone() {
  return normalizePhone(process.env.FOUNDER_NUMBER || "");
}

export async function listContacts() {
  const list = await readAll();
  return list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Create or update (pass an existing id to update). */
export async function saveContact({ id, name, phone, note }) {
  const clean = String(name || "").trim();
  if (!clean) throw new Error("name is required");
  const number = normalizePhone(phone);
  if (number.length < 8) throw new Error("phone number looks invalid — include the country code");

  const list = await readAll();
  const now = new Date().toISOString();
  const existing = id ? list.find((c) => c.id === id) : null;
  const contact = {
    id: existing?.id || crypto.randomUUID(),
    name: clean,
    phone: number,
    note: String(note || "").trim(),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  await writeAll(existing ? list.map((c) => (c.id === contact.id ? contact : c)) : [...list, contact]);
  return contact;
}

export async function deleteContact(id) {
  const list = await readAll();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) throw new Error("contact not found");
  await writeAll(next);
  return { ok: true };
}

/**
 * Resolve what the founder said ("bhej do Rahul ko") to one contact. Exact name
 * wins, then prefix, then substring — and an ambiguous query returns the
 * candidates instead of guessing, because guessing here texts the wrong person.
 */
// "mujhe bhej do" / "send it to me" — the founder means his own number, and it
// is never in the contact book under whatever word he happened to use.
const SELF = /^(me|mujhe|mujhko|mereko|my ?self|self|khud|founder|sir|boss|anish)$/i;

export async function findContact(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { ok: false, error: "no name given" };

  if (SELF.test(q)) {
    const phone = founderPhone();
    if (phone) return { ok: true, contact: { name: "you", phone } };
    return { ok: false, error: "FOUNDER_NUMBER is not set in .env, so I don't know your own number" };
  }

  const list = await listContacts();
  if (!list.length) return { ok: false, error: "the contact book is empty — add contacts in the Contacts tab first" };

  const name = (c) => String(c.name).toLowerCase();
  let hits = list.filter((c) => name(c) === q);
  if (!hits.length) hits = list.filter((c) => name(c).startsWith(q));
  if (!hits.length) hits = list.filter((c) => name(c).includes(q) || q.includes(name(c)));
  // Typed a number instead of a name? Match on that too.
  if (!hits.length && /\d/.test(q)) {
    const digits = normalizePhone(q);
    hits = list.filter((c) => c.phone === digits);
  }

  if (!hits.length) return { ok: false, error: `no contact named "${query}"` };
  if (hits.length > 1) {
    return { ok: false, ambiguous: hits.map((c) => c.name), error: `several contacts match "${query}": ${hits.map((c) => c.name).join(", ")} — ask which one` };
  }
  return { ok: true, contact: hits[0] };
}
