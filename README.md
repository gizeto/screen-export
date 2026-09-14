# comps-rehost

Standalone userscript for selecting comparison images, rehosting them on slow.pics, and downloading originals.

Install [comps-rehost.user.js](comps-rehost.user.js) in Tampermonkey, or paste its contents into a new script. Hosted update URLs will be added when the project is published in its own repository.

This script targets **Chrome with Tampermonkey**. Use Tampermonkey **5.4.6226 or newer** for Blob downloads; other managers are not supported. Enable Tampermonkey's browser context menu and downloads permission. PNG, JPG, WebP, GIF, and BMP extensions must be allowed in its download settings.

1. Right-click the page, then choose **Tampermonkey → comps-rehost**.
2. Click the comparison area. The script suggests the nearest image section. Use **Expand to parent** for a larger block or **Choose another area** to pick again.
3. Click images to toggle them, or click the first image and Shift-click the last to select an inclusive range in either direction. **Select all** and **Clear** are also available.
4. Check the collection name, column names, and preview. Consecutive selected images form rows. A nearby `Source vs Encode` heading supplies names and column count; otherwise the defaults are two unnamed columns.
5. Choose **Upload to slow.pics** or **Download originals**. Both actions require complete rows so every column has the same number of pictures. Collections are **public by default**; uncheck **Public on slow.pics** to request an unlisted collection.

There is no userscript execution before the context-menu command: no page scan, listener, cookie/storage access, or request. The userscript manager itself still needs site permissions. After invocation, thumbnail previews can load images. Original-image resolution and slow.pics requests start only when you choose an output action. Tampermonkey may ask to allow an unfamiliar image host.

Full-image links and standard host-page image metadata take precedence over thumbnails. Small URL resolvers handle ImgBB, img4k, Pixhost (pixhost.cc, pixhost.to, and pixho.st), and proxy/redirect URLs; page detection does not use tracker-specific selectors. Pixhost pages use their displayed full-size image; thumbnail URLs are also resolved to originals. Original bytes and image formats are preserved, and slow.pics image optimization is disabled. Known unresolved thumbnails, invalid image responses, and failed uploads produce errors.

Transfers run sequentially. **Cancel transfer** stops further requests; completed downloads remain saved. After an interrupted upload, **Retry upload** resumes the same collection in the open dialog. Its configuration stays locked until **Start over**. Closing the dialog, navigating away, or starting over discards local retry state; an incomplete remote collection may remain. A timeout during collection creation can also leave an unconfirmed collection. No remote collections are automatically deleted.

Downloads are individual files in the browser's download directory. Names follow slow.pics' automatic grouping format: `Source0001.png`, `Encode0001.png`, `Source0002.png`, `Encode0002.png`. The column name comes first and the shared comparison number is padded to at least four digits. The collection title is not part of filenames. Direct uploads use the same filenames and comparison numbers.

Filename-unsafe characters become underscores. A column ending in a digit gets an underscore before the frame number (`x265_0001.png`) to keep its digits separate from the comparison number. Names that collide after sanitizing, including case-only differences, must be edited before downloading. Use an empty destination for each set. In Tampermonkey's browser download mode, existing filename conflicts prompt instead of silently adding a suffix that breaks grouping. Failed or cancelled downloads leave an incomplete set that needs to be completed before importing into slow.pics. Completed uploads display a comparison link with a **Copy link** button.

The script reads accessible `<img>` elements, including hidden/lazy images already in the DOM. It does not extract canvas images, inaccessible frames, raw BBCode, or images that a site has not yet created. Open site content before invoking it when needed. Unknown image sizes are retained, so decorative images can occasionally need deselection. Headings and grouping are suggestions to review, especially when a page contains several comparisons or no heading.

## Upload diagnostics

Version 1.1.0 reuses an existing slow.pics CSRF cookie before fetching its upload page. Slow.pics requests explicitly use its first-party cookie partition, browser-managed cookies, and the upload page's Referer/Origin. CSRF cookies and page metadata use their respective CSRF headers. Credentials are never copied to image hosts, and the script does not override your browser's User-Agent.

A 403 alone does not identify whether authentication, CSRF validation, or an access challenge failed. Expand **Debug log** and choose **Copy debug log** to capture the failing method and endpoint (`GET /comparison`, `POST /upload/comparison`, or `POST /upload/image`). The same entries appear in the page console under `[comps-rehost]`. Logs include status, response type, a coarse error category, token source/presence, and userscript-manager version. They omit cookie/token values, request/response bodies, collection names, image filenames, URL queries, and image paths. Logs stay in memory and are not uploaded.

403 responses, 429 rate limits, and detected access challenges stop the transfer immediately, including image-host fallback attempts and subsequent downloads. The script does not retry automatically. A server's `Retry-After` is respected for further requests to that host while the dialog remains open. Check [slow.pics/comparison](https://slow.pics/comparison) in its own tab if login or normal access needs attention; do not repeatedly retry if access is blocked. A 403 can still persist because of a server-side block or userscript-manager cookie behavior. Share the debug log to distinguish these cases.

The integration uses slow.pics' website upload endpoints, which can change. Automated tests mock all transfer responses and do not contact slow.pics. Live upload compatibility remains unverified.

## Tests

Run `node --test tests/*.test.cjs`. The comparison tests use an isolated headless Chrome profile and no additional packages. Set `CHROME_BIN` if Chrome is not in a standard location. HTTP(S) requests from the test page are blocked in Chrome, external fixture resources are also blocked by CSP, and transfer APIs are mocked. Sanitized examples are embedded in the tests; when `tmp/comp-examples/ex1.html` through `ex9.html` and `ex9_pixhost.html` are present, those samples are checked too. Browser tests are skipped when Chrome cannot be found.

Before release, manually check the native Tampermonkey menu, absence of script activity before invocation, and an actual upload and download. Headless DOM tests do not verify userscript-manager permissions, browser-managed sessions, or the live slow.pics service.

The original reference userscript and supplied HTML examples are kept locally in `tmp/`, which is ignored by Git.
