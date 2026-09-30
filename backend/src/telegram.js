const TELEGRAM_API = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 4096;

// Telegram renders a small HTML subset; everything interpolated into a
// message must be escaped or a container name with "<" breaks the message.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Sends messages to one Telegram chat. Sends are queued so they arrive in
// order and never run in parallel (Telegram rate-limits per chat). A failed
// send is retried a few times and then dropped with a log line - alerting
// must never crash or block the app.
function createTelegramNotifier({
  botToken,
  chatId,
  fetchImpl = globalThis.fetch,
  logger = console,
  maxAttempts = 3,
  retryDelayMs = 1000,
  sleep = delay,
  apiBase = TELEGRAM_API
}) {
  if (!botToken || !chatId) {
    throw new Error('Telegram notifier needs both a bot token and a chat id');
  }

  const url = `${apiBase}/bot${botToken}/sendMessage`;
  let queue = Promise.resolve();

  // Error text may end up in logs or the admin UI: make sure the token
  // (part of the request URL) can never appear in it
  const scrub = message => String(message).split(botToken).join('<token>');

  // Returns { ok, error } - error is a short human-readable reason
  async function deliver(text) {
    const body = {
      chat_id: chatId,
      text: text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 3)}...` : text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };

    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (response.ok) return { ok: true };

        // 429 tells us how long to wait; 5xx is worth retrying, 4xx is not
        const payload = await response.json().catch(() => ({}));
        lastError = scrub(`HTTP ${response.status}: ${payload?.description || 'no description'}`);
        if (response.status === 429) {
          if (attempt < maxAttempts) {
            await sleep(Number(payload?.parameters?.retry_after || 1) * 1000);
            continue;
          }
        } else if (response.status < 500) {
          logger.error(`[telegram] send rejected (${lastError})`);
          return { ok: false, error: lastError };
        }
      } catch (error) {
        lastError = scrub(error.cause?.code || error.message);
      }
      if (attempt < maxAttempts) await sleep(retryDelayMs * attempt);
    }

    logger.error(`[telegram] send failed after ${maxAttempts} attempts (${lastError})`);
    return { ok: false, error: lastError };
  }

  function enqueue(text) {
    queue = queue.then(() => deliver(text)).catch(error => {
      logger.error(`[telegram] unexpected error: ${scrub(error.message)}`);
      return { ok: false, error: 'unexpected error' };
    });
    return queue;
  }

  return {
    // Resolves to true/false once this message has been delivered (or given up on)
    send(text) {
      return enqueue(text).then(result => result.ok);
    },
    // Same, but resolves to { ok, error } so callers can show the reason
    sendWithResult(text) {
      return enqueue(text);
    },
    // Waits for everything queued so far
    flush() {
      return queue.then(() => undefined);
    }
  };
}

module.exports = { createTelegramNotifier, escapeHtml, MAX_MESSAGE_LENGTH };
