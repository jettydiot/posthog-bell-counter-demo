import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, and guarding it with a length
 * check would leak the secret's length through timing. Hashing both sides first
 * gives two fixed-width 32-byte digests, so the comparison itself is always the
 * same amount of work regardless of what the caller sent.
 */
export function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Replace any occurrence of a secret in a string with a placeholder.
 * Belt-and-braces for error messages built from upstream response bodies.
 */
export function redact(text, ...secrets) {
  let output = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      output = output.split(secret).join('[redacted]');
    }
  }
  return output;
}
