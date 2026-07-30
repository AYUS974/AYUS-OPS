import "dotenv/config";
import { db } from "../src/lib/supabase.js";

async function clearFakeData() {
  console.log("Clearing fake data from Supabase DB...");

  // 1. Delete fake invoices (Mehta & Associates, Skyline Media, GreenLeaf Organics, example.com)
  const { error: invErr } = await db
    .from("invoices")
    .delete()
    .or("client_email.ilike.%example.com%,client_name.ilike.%Mehta%,client_name.ilike.%Skyline%,client_name.ilike.%GreenLeaf%");
  if (invErr) console.error("Error clearing invoices:", invErr.message);
  else console.log("Successfully cleared fake invoices.");

  // 2. Delete fake leads (Rohit Sharma, Priya Patel, Random User, example.com)
  const { error: leadErr } = await db
    .from("leads")
    .delete()
    .or("email.ilike.%example.com%,name.ilike.%Rohit%,name.ilike.%Priya%,name.ilike.%Random%");
  if (leadErr) console.error("Error clearing leads:", leadErr.message);
  else console.log("Successfully cleared fake leads.");

  // 3. Delete fake pending actions
  const { error: actErr } = await db
    .from("pending_actions")
    .delete()
    .or("title.ilike.%GreenLeaf%,title.ilike.%Skyline%,title.ilike.%Mehta%");
  if (actErr) console.error("Error clearing pending actions:", actErr.message);
  else console.log("Successfully cleared fake pending actions.");

  console.log("Done!");
}

clearFakeData().catch(console.error);
