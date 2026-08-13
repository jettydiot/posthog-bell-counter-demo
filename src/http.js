/**
 * The one place an outbound HTTP call is made.
 *
 * `fetch` is injected rather than reached for globally, so every test drives
 * the real client code against a double instead of monkey-patching globals.
 */

export async function postJson(fetchImpl, url, { headers = {}, body, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Read a JSON body without letting a malformed response mask the status code. */
export async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
