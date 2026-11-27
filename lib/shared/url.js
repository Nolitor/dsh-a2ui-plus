/**
 * URL and path admission for model-authored components.
 *
 * A model can put any string in `url` or `svgPath`; the renderer must only hand
 * the browser values that cannot execute script or reach local files. These
 * rules are explicit and testable, rather than relying on React's defaults.
 */
const HTTP_URL = /^https?:\/\/[^\s"'<>]+$/iu;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/u;
const SVG_PATH = /^[0-9eE\s,.\-+MmLlHhVvCcSsQqTtAaZz]*$/u;
/** Maximum characters accepted for a URL or path. */
const MAX_LENGTH = 8_192;
/**
 * Admit a media URL.
 * @param value authored URL.
 * @param allowDataImage whether an inline `data:image/*;base64` URI is allowed (images only).
 * @returns the trimmed URL, or `undefined` when it must not be loaded.
 */
export function safeMediaUrl(value, allowDataImage) {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > MAX_LENGTH)
        return undefined;
    if (HTTP_URL.test(trimmed))
        return trimmed;
    if (allowDataImage && DATA_IMAGE.test(trimmed) && trimmed.length <= MAX_LENGTH)
        return trimmed;
    return undefined;
}
/**
 * Admit a link target for `openUrl` / anchor-like actions.
 * @returns the URL when it is an http(s) URL safe to hand to the OS browser.
 */
export function safeExternalUrl(value) {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > MAX_LENGTH)
        return undefined;
    return HTTP_URL.test(trimmed) ? trimmed : undefined;
}
/**
 * Admit an SVG path for the `Icon` component.
 * @returns the path when it contains only path grammar characters.
 */
export function safeSvgPath(value) {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.length > MAX_LENGTH)
        return undefined;
    return SVG_PATH.test(trimmed) ? trimmed : undefined;
}
