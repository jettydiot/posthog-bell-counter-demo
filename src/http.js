/**
 * The one place an outbound HTTP call is made.
 *
 * `fetch` is injected rather than reached for globally, so every test drives
 * the real client code against a double instead of monkey-patching globals.
 */

export async function postJson(fetchImpl, url, { headers = {}, body, timeoutMs = 10000 } = {}) {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    // `AbortSignal.timeout` rather than a timer cleared once headers arrive: the
    // deadline has to outlive the response headers. A peer that sends a status
    // line and then stalls mid-body would otherwise leave `readJson` pending
    // forever, holding the single run slot open and the webhook unanswered.
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Read a JSON body without letting a malformed response mask the status code. */
export async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
