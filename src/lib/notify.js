/**
 * Outbound notifications — so you hear from the company without keeping the
 * dashboard open. Telegram is the default channel (free, instant, 2-minute
 * setup). Without a token configured, messages print to the server console.
 *
 * Setup: create a bot via @BotFather, then set TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID (message your bot once, then read the chat id from
 * https://api.telegram.org/bot<token>/getUpdates).
 */

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;
const CHAT = () => process.env.TELEGRAM_CHAT_ID;

export function notifyConfigured() {
  return Boolean(TOKEN() && CHAT());
}

/**
 * Send a notification. Best-effort: a failed send never throws into a run.
 * @param {string} text - markdown-ish plain text (HTML parse mode)
 * @param {{urgent?: boolean}} [opts]
 */
export async function notify(text, { urgent = false } = {}) {
  const body = urgent ? `🔴 <b>URGENT</b>\n${text}` : text;

  if (!notifyConfigured()) {
    console.log(`[notify${urgent ? ":urgent" : ""}] ${text}`);
    return { ok: true, channel: "console" };
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT(),
        text: body,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!r.ok) throw new Error(`Telegram ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return { ok: true, channel: "telegram" };
  } catch (err) {
    console.error(`[notify] failed: ${err.message || err}`);
    console.log(`[notify:fallback] ${text}`);
    return { ok: false, error: String(err.message || err) };
  }
}

// Escape user/agent text before putting it in an HTML-parse-mode message.
export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
