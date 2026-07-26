/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 *
 * Forge renders almost everything through React, which escapes for us. The
 * exceptions are the handful of routes that hand-build an HTML string
 * (the GitHub App manifest bootstrap flow), where interpolated values come
 * back from an external API and are not trustworthy.
 *
 * `&` must be replaced first — otherwise it would re-escape the ampersands
 * introduced by the later replacements and produce `&amp;lt;` from `<`.
 * Both quote styles are covered so the result is safe in single- or
 * double-quoted attributes as well as in text.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
