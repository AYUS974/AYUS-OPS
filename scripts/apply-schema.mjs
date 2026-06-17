// One-off: applies supabase/schema.sql (and seed.sql if the DB is empty)
// over a direct Postgres connection. Usage:
//   node scripts/apply-schema.mjs "postgresql://...connection string..."
import { readFileSync } from "node:fs";
import pg from "pg";

const conn = process.argv[2];
if (!conn) {
  console.error("usage: node scripts/apply-schema.mjs <connection-string>");
  process.exit(1);
}

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
await client.connect();

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
await client.query(schema);
console.log("schema applied ✓");

const { rows: tables } = await client.query(
  `select table_name from information_schema.tables
   where table_schema = 'public' order by table_name`
);
console.log("tables:", tables.map((t) => t.table_name).join(", "));

const { rows: [{ count }] } = await client.query("select count(*)::int as count from leads");
if (count === 0) {
  const seed = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");
  await client.query(seed);
  console.log("seed data inserted ✓");
} else {
  console.log(`leads table already has ${count} row(s) — skipping seed`);
}

const summary = await client.query(
  `select 'leads' t, count(*)::int n from leads
   union all select 'invoices', count(*)::int from invoices
   union all select 'content_items', count(*)::int from content_items`
);
for (const r of summary.rows) console.log(`  ${r.t}: ${r.n} rows`);

await client.end();
