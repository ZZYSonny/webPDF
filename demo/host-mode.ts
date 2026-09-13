/**
 * The one thing that has to happen before the first paint: say that this page was
 * opened by a host (`?host=1`) which already has a document for it.
 *
 * The class it sets is what hides the card that offers a document - and with it
 * the example papers - for a page that was opened *with* one: a viewer inside the
 * browser extension must never flash a welcome page. `demo/main.ts` hides the
 * card too, but only once the module graph has loaded, and a frame that shows a
 * "drop a PDF here" card for a tenth of a second is a frame that showed the wrong
 * thing.
 *
 * A classic script in the head, and a file rather than the obvious inline
 * snippet, because an extension page's Content Security Policy does not allow
 * inline scripts at all - the packaged viewer is served under one.
 */

if (new URLSearchParams(location.search).get('host') === '1') {
  document.documentElement.classList.add('wpdf-host');
}
