import { db } from "./supabase.js";
import { sendEmail } from "./email.js";

/**
 * Executes an APPROVED action. This is the only place side effects happen.
 *
 * Email goes through src/lib/email.js — real sending via Resend when
 * RESEND_API_KEY is set, console stub otherwise. Either way every send is
 * logged to the sent_emails table.
 */
export async function executeAction(action) {
  switch (action.type) {
    case "send_followup":
    case "send_reminder": {
      await sendEmail({
        to: action.payload.to,
        subject: action.payload.subject,
        body: action.payload.body,
        agent: action.agent,
        actionId: action.id,
      });
      if (action.type === "send_reminder" && action.payload.invoice_id) {
        await db
          .from("invoices")
          .update({ last_reminder_at: new Date().toISOString() })
          .eq("id", action.payload.invoice_id);
      }
      if (action.type === "send_followup" && action.payload.lead_id) {
        await db.from("leads").update({ status: "contacted" }).eq("id", action.payload.lead_id);
      }
      return;
    }

    case "content_review": {
      await db
        .from("content_items")
        .update({ status: "reviewed", ai_review: action.payload.review })
        .eq("id", action.payload.content_id);
      return;
    }

    case "manual_task": {
      // Manual tasks represent administrative reminders/tasks.
      // Executing them has no side effects other than changing their state.
      return;
    }

    case "schedule_interview": {
      // Moves the candidate to the interview stage. If Google Calendar is
      // connected, also drops a tentative 30-min slot tomorrow (best effort).
      const { candidate_id, candidate_name, candidate_email, role } = action.payload || {};
      if (candidate_id) {
        await db.from("candidates").update({ status: "interview" }).eq("id", candidate_id);
      }
      try {
        const { createCalendarEvent, isGoogleConnected } = await import("./google.js");
        if (await isGoogleConnected()) {
          const start = new Date();
          start.setDate(start.getDate() + 1);
          start.setHours(11, 0, 0, 0);
          const end = new Date(start.getTime() + 30 * 60000);
          await createCalendarEvent({
            summary: `Interview: ${candidate_name || "candidate"} — ${role || ""}`.trim(),
            description: `Auto-scheduled by Isha (HR agent) for AYUS Labs.`,
            start: start.toISOString(),
            end: end.toISOString(),
            attendees: candidate_email ? [candidate_email] : [],
          });
        }
      } catch (err) {
        console.error(`[executor] interview calendar slot skipped: ${err.message || err}`);
      }
      return;
    }

    case "draft_invoice": {
      // Finance handoff: create a real invoice row from an approved draft.
      const p = action.payload || {};
      if (!p.client_name || p.amount == null) throw new Error("draft_invoice needs client_name and amount");
      await db.from("invoices").insert({
        client_name: p.client_name,
        client_email: p.client_email || null,
        amount: p.amount,
        currency: p.currency || "INR",
        due_date: p.due_date || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
        status: "unpaid",
      });
      return;
    }

    case "calendar_event": {
      const { createCalendarEvent } = await import("./google.js");
      await createCalendarEvent(action.payload || {});
      return;
    }

    case "gmail_reply":
    case "gmail_send": {
      const { sendGmail } = await import("./google.js");
      await sendGmail(action.payload || {});
      return;
    }

    case "candidate_review": {
      await db
        .from("candidates")
        .update({
          status: "screened",
          ai_score: action.payload.review?.score ?? null,
          ai_review: action.payload.review,
        })
        .eq("id", action.payload.candidate_id);
      return;
    }

    case "tech_review": {
      await db
        .from("project_updates")
        .update({
          status: "triaged",
          ai_priority: action.payload.review?.priority ?? null,
          ai_review: action.payload.review,
        })
        .eq("id", action.payload.update_id);
      return;
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}
