/**
 * The one question the worker asks about an address: would this extension open
 * it at all.
 *
 * Kept apart from the interception itself so that the answer is in one place -
 * the rule, the header watch and the viewer page all have to agree with it - and
 * so that it can be read without reading the worker.
 */

/** A URL that can be fetched and shown: the only schemes that are ever touched. */
export function isOpenable(url: unknown): url is string {
  return typeof url === 'string' && /^(https?|file):/i.test(url) && !url.startsWith('chrome');
}
