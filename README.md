# comps-rehost

Standalone userscript for selecting comparison images, rehosting them on slow.pics, and downloading originals.

Install [comps-rehost.user.js](comps-rehost.user.js) in Tampermonkey, or paste its contents into a new script. Hosted update URLs will be added when the project is published in its own repository.

This script targets **Chrome with Tampermonkey**. Use Tampermonkey **5.4.6226 or newer** for Blob downloads; other managers are not supported. Enable Tampermonkey's browser context menu and downloads permission. PNG, JPG, WebP, GIF, and BMP extensions must be allowed in its download settings.

1. Click the Tampermonkey toolbar icon, find **comps-rehost**, and choose **Select comparison images**. The command is also available in Tampermonkey's page context menu when enabled.
2. Click the comparison area. The script suggests the nearest image section. Use **Expand to parent** for a larger block or **Choose another area** to pick again.
3. Click images to toggle them, or click the first image and Shift-click the last to select an inclusive range in either direction. **Select all** and **Clear** are also available. Hover over the nearby **?** icon (or focus it with the keyboard) for selection help.
4. Check the collection name, column names, and preview. **Image order** defaults to **Row by row**, where consecutive selected images form rows. Choose **Column by column** when the page lists all images from the first column, then all from the second, etc. The selected images are split equally between columns; the preview, download filenames, and upload slots all follow that arrangement. A nearby heading with names separated by `vs`, `|`, or repeated nonbreaking spaces (`&nbsp;`) supplies names and column count; otherwise the defaults are two unnamed columns. Single spaces within names, such as `Old GroupA`, are preserved.
5. Choose **Upload to slow.pics** or **Download originals**. Both actions require complete rows so every column has the same number of pictures. Collections are **unlisted by default**; check **Public on slow.pics** to make a collection public.

The collection name is suggested from the page title as `Movie Title Year Resolution - Source vs Encode` or `TV Title [Year] S01 Resolution - Source vs Encode`, using all current column names. Dot-separated titles are normalized, and alternate titles after `AKA` and release details are omitted. Unrecognized titles fall back to `Comparison - Source vs Encode`. The suggestion follows column edits until you edit the collection name yourself.

To enable title search, click the Tampermonkey toolbar icon, find **comps-rehost**, and choose **⚙ TMDB API key: not set**. Paste your [TMDB API key](https://developer.themoviedb.org/docs/authentication-application) into the prompt and click **OK**. The menu label changes to **⚙ TMDB API key: configured**. This works before opening the comparison picker; there is no in-page Settings panel. The key is saved as `tmdb_api_key` in Tampermonkey's userscript storage for future sessions. Submit an empty value to clear it, or **Cancel** to keep the current key. Changes apply to an open comparison dialog in the same tab. The saved key is never displayed in the menu or prefilled in the prompt, and is never included in uploads or debug logs. After updating the userscript, reload the page to register the new menu commands.

With a saved key, enter a title and click **Search TMDB** (or press Enter). **Search for** automatically selects **TV** when the page title contains a season or episode marker (such as `S01E02`, `Season 1`, or `1x02`), and **Movie** otherwise; you can change it. The title is suggested from the page when recognizable. The fixed-size, scrollable **Search results** dropdown shows titles, years, countries, and posters. Choose a match to fill the TMDB id; arrow keys, Home/End, and Enter also work, and Escape closes the dropdown. Missing countries or posters have explicit placeholders. Movie countries load through additional TMDB detail requests after the results appear. Posters load from TMDB's image server.

Search retrieves the first page of matches; refine the title if needed. TMDB requests start only on an explicit search; typing does not send requests, and search never contacts slow.pics. Errors do not trigger automatic retries. Changing Movie/TV clears the previous link to avoid mixing movie and series IDs.

The **TMDB id** field is always available, including without an API key. Enter `tv/124` for a TV series or `movie/567` for a movie, using its numeric TMDB ID (for TV, use the series ID, not a season or episode ID). Leave it blank for no link. The link stays fixed during upload retries; use **Start over** to change it. Invalid references block uploads but do not block downloads.

The upload sends `tmdbId` as `MOVIE_<id>` or `TV_<id>`, matching the format used by [McBaws/comp](https://github.com/McBaws/comp/blob/main/comp.py). Live linking remains unverified because direct inspection of the slow.pics form was blocked.

On page load, a small startup step registers the two Tampermonkey menu commands and reads whether a TMDB key is configured. It does not scan images, create page UI, read cookies, or make network requests. **Select comparison images** launches the picker; thumbnail previews can then load images. Original-image resolution and slow.pics requests start only when you choose an output action. Tampermonkey may ask to allow an unfamiliar image host.

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

Run `npm ci`, then `npm test` (or `node --test tests/*.test.cjs`). Tests run entirely in Node using jsdom; no Chrome or other browser is launched. External resources are not loaded, and image decoding, dialogs, and transfer APIs are mocked. Sanitized examples are embedded in the tests; when `tmp/comp-examples/ex1.html` through `ex10.html` and `ex9_pixhost.html` are present, those samples are checked too.

Before release, manually check the native Tampermonkey menu and key prompt, absence of page UI and network requests before launching the picker, and an actual upload and download. Node DOM tests do not verify native image decoding, dialog behavior, userscript-manager permissions, browser-managed sessions, or the live slow.pics service.

The original reference userscript and supplied HTML examples are kept locally in `tmp/`, which is ignored by Git.
