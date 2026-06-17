import { Resend } from "resend";
import { db } from "./supabase.js";

const FROM = process.env.EMAIL_FROM || "AYUS Labs <onboarding@resend.dev>";
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sends an email and logs it to the sent_emails table.
 *
 * If RESEND_API_KEY is not set, falls back to printing the email to the
 * server console (still logged to sent_emails with provider 'stub') so the
 * whole approval loop works before you've set up a provider.
 *
 * @param {object} opts
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.body - plain text body
 * @param {string} [opts.agent] - which agent produced this email
 * @param {string} [opts.actionId] - the pending_actions row that triggered it
 */
export async function sendEmail({ to, subject, body, agent, actionId }) {
  if (!to || !EMAIL_RE.test(to)) throw new Error(`invalid recipient email: ${JSON.stringify(to)}`);
  if (!subject?.trim()) throw new Error("email subject is empty");
  if (!body?.trim()) throw new Error("email body is empty");

  let provider = "stub";
  let providerId = null;

  if (resend) {
    const { data, error } = await resend.emails.send({
      from: FROM,
      to,
      subject,
      text: body,
    });
    if (error) throw new Error(`Resend failed: ${error.message}`);
    provider = "resend";
    providerId = data?.id ?? null;
  } else {
    console.log("─".repeat(60));
    console.log(`[email stub] To: ${to}`);
    console.log(`[email stub] Subject: ${subject}`);
    console.log(`[email stub] Body:\n${body}`);
    console.log("─".repeat(60));
  }

  const { error: logError } = await db.from("sent_emails").insert({
    to_email: to,
    subject,
    body,
    provider,
    provider_id: providerId,
    agent: agent ?? null,
    action_id: actionId ?? null,
  });
  // The email already went out — a logging failure shouldn't fail the action.
  if (logError) console.error(`[email] sent but failed to log: ${logError.message}`);
}
