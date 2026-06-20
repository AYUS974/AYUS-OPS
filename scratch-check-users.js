import "dotenv/config";
import { db } from "./src/lib/supabase.js";

async function main() {
  try {
    const { data: { users }, error } = await db.auth.admin.listUsers();
    if (error) throw error;
    console.log("Users in Supabase Auth:");
    users.forEach(u => {
      console.log(`- Email: ${u.email}, Confirmed: ${u.email_confirmed_at ? "Yes" : "No"}`);
    });
  } catch (err) {
    console.error("Error listing users:", err);
  }
}

main();
