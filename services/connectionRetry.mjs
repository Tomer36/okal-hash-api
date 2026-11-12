import https from "https";

// Hashavshevet sometimes closes a connection before sending any answer ("socket hang up", or a
// secure connection dropped while it was being set up). Node reuses idle connections, so a
// request can go out on one the provider has just closed. Reports only read data, so sending
// the request once more, on a new connection, is safe.
const DROPPED_CONNECTION_CODES = new Set(["ECONNRESET", "EPIPE"]);
// The retry is skipped when less time than this is left: it could not get an answer anyway.
export const MIN_RETRY_TIME_MS = 2000;
const freshConnectionAgent = new https.Agent({ keepAlive: false });

// True only for a connection closed before any answer. A timeout, a cancellation or an error
// answer from the provider is never retried.
export function isDroppedConnection(error) {
  if (!error || error.response) return false;
  if (error.code === "ERR_CANCELED" || error.name === "CanceledError" || error.name === "AbortError") return false;
  return DROPPED_CONNECTION_CODES.has(error.code) || /socket hang up/i.test(String(error.message || ""));
}

// Runs attempt(requestOptions) and, when the connection was dropped and enough time is left,
// once more on a new connection. requestOptions carries the time left for that attempt.
export async function sendWithOneRetry(attempt, { timeoutMs, signal, onRetry = () => {}, now = Date.now } = {}) {
  const endsAt = now() + timeoutMs;
  try {
    return await attempt({ timeout: Math.max(1, timeoutMs) });
  } catch (error) {
    const timeLeft = endsAt - now();
    if (!isDroppedConnection(error) || signal?.aborted || timeLeft < MIN_RETRY_TIME_MS) throw error;
    onRetry(error);
    return attempt({ timeout: timeLeft, httpsAgent: freshConnectionAgent });
  }
}
