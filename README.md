# comps-rehost

Standalone userscript for selecting images, rehosting comparisons on slow.pics or individual images on PTScreens, ImgBB and Pixhost, and downloading originals.

Install [comps-rehost.user.js](comps-rehost.user.js) in Tampermonkey, or paste its contents into a new script. Hosted update URLs will be added when the project is published in its own repository.

This script targets **Chrome with Tampermonkey**. Use Tampermonkey **5.4.6226 or newer** for Blob downloads; other managers are not supported. Enable Tampermonkey's browser context menu and downloads permission. PNG, JPG, WebP, GIF, and BMP extensions must be allowed in its download settings.

1. Click the Tampermonkey toolbar icon, find **comps-rehost**, and choose **Select comparison images**. The command is also available in Tampermonkey's page context menu when enabled.
2. Click the image area. The script suggests the nearest image section. Use **Expand to parent** for a larger block or **Choose another area** to pick again.
3. Click images to toggle them, or click the first image and Shift-click the last to select an inclusive range in either direction. **Select all** and **Clear** are also available. Hover over the nearby **?** icon (or focus it with the keyboard) for selection help.
4. Choose a **Destination**. The default, **slow.pics**, creates a comparison. **PTScreens**, **ImgBB**, and **Pixhost** upload standalone images; see below. For slow.pics, check the collection name, column names, and preview. **Image order** defaults to **Row by row**, where consecutive selected images form rows. Choose **Column by column** when the page lists all images from the first column, then all from the second, etc. The selected images are split equally between columns; the preview, download filenames, and upload slots all follow that arrangement. A nearby heading with names separated by `vs`, `|`, commas, spaced hyphens (` - `), or repeated nonbreaking spaces (`&nbsp;`) supplies names and column count; otherwise the defaults are two unnamed columns. Unrelated text stops a heading from applying to later images. Single spaces within names, such as `Old GroupA`, and hyphens within names, such as `WEB-DL`, are preserved.
5. Choose **Upload to slow.pics** or **Download originals**. With slow.pics selected, both actions require complete rows so every column has the same number of pictures. Collections are **unlisted by default**; check **Public on slow.pics** to make a collection public.

## Standalone image uploads

Choose **PTScreens**, **ImgBB**, or **Pixhost** in **Destination**. Collection, TMDB, column, and comparison-order fields are hidden. Select any number of images, including one or an odd count; uploads and output follow their order on the page. The destination resets to slow.pics when you reopen the picker.

For PTScreens and ImgBB, configure **PTScreens API key: not set** or **ImgBB API key: not set** in the Tampermonkey menu. Keys are saved as `ptscreens_api_key` and `imgbb_api_key`. An empty prompt clears the key; Cancel keeps it. Prompts never prefill saved keys. Each key is sent only to its upload API, never to source-image hosts or debug logs. Missing keys block uploads before fetching originals. Pixhost needs no key; its **NSFW on Pixhost** checkbox is unchecked by default.

Click **Upload to PTScreens**, **Upload to ImgBB**, or **Upload to Pixhost**. Completed images immediately appear in a selectable BBCode field with **Copy BBCode**. Each entry links the original image to its host page, and entries are separated by spaces:

```text
[url=https://host.example/image/one][img]https://images.host.example/one.png[/img][/url]
```

**BBCode image width** starts blank. Enter a positive integer such as `350` to generate `[img=350]`; clear it for `[img]`. Valid changes, including blank, are saved as `image_bbcode_width` and prefilled on future launches. The field remains editable after uploading. Changing it only reformats the BBCode; it does not resize images or upload again.

Uploads run sequentially and stop at the first failure or cancellation. Completed results remain copyable. **Retry upload** resumes at the first unconfirmed image using the host's current saved key. Selection, destination and NSFW settings stay locked until **Start over**. A timed-out or cancelled upload may have succeeded remotely; retrying that image can create a duplicate. There are no automatic retries, host switches, or remote deletions. Closing, navigating away, or starting over discards local results and retry state.

**Download originals** also works in standalone mode without an API key, using names such as `Image0001.png`, `Image0002.jpg`, in page order. Original bytes and detected formats are preserved. The existing resolver supports PNG, JPEG, WebP, GIF and BMP. ImgBB's 32 MB and Pixhost's 10 MB limits are checked before each upload; Pixhost rejects BMP. Images are not converted to work around limits. Pixhost optimization is left off and no galleries are created.

Integrations follow the [PTScreens-contributed Upload Assistant adapter](https://github.com/L4GSP1KE/Upload-Assistant/pull/352/files), [ImgBB API](https://api.imgbb.com/), and [Pixhost API](https://pixhost.to/api/index.html). PTScreens documentation could not be fetched, so its compatibility remains unverified against the live service. All three integrations are covered by mocked tests; live uploads have not been performed.

## slow.pics comparisons

The collection name is suggested from the page title as `Movie Title Year Resolution - Source vs Encode` or `TV Title [Year] S01 Resolution - Source vs Encode`, using all current column names. Dot-separated titles are normalized, and alternate titles after `AKA` and release details are omitted. Unrecognized titles fall back to `Comparison - Source vs Encode`. The suggestion follows column edits until you edit the collection name yourself.

To enable title search, click the Tampermonkey toolbar icon, find **comps-rehost**, and choose **TMDB API key: not set**. Paste your [TMDB API key](https://developer.themoviedb.org/docs/authentication-application) into the prompt and click **OK**. The menu label changes to **TMDB API key: configured**. This works before opening the comparison picker; there is no in-page Settings panel. The key is saved as `tmdb_api_key` in Tampermonkey's userscript storage for future sessions. Submit an empty value to clear it, or **Cancel** to keep the current key. Changes apply to an open comparison dialog in the same tab. The saved key is never displayed in the menu or prefilled in the prompt, and is never included in uploads or debug logs. After updating the userscript, reload the page to register the new menu commands.

With a saved key, enter a title and click **Search TMDB** (or press Enter). **Search for** automatically selects **TV** when the page title contains a season or episode marker (such as `S01E02`, `Season 1`, or `1x02`), and **Movie** otherwise; you can change it. The title is suggested from the page when recognizable. The fixed-size, scrollable **Search results** dropdown shows titles, years, countries, and posters. Choose a match to fill the TMDB id; arrow keys, Home/End, and Enter also work, and Escape closes the dropdown. Missing countries or posters have explicit placeholders. Movie countries load through additional TMDB detail requests after the results appear. Posters load from TMDB's image server.

Search retrieves the first page of matches; refine the title if needed. TMDB requests start only on an explicit search; typing does not send requests, and search never contacts slow.pics. Errors do not trigger automatic retries. Changing Movie/TV clears the previous link to avoid mixing movie and series IDs.

For slow.pics, the **TMDB id** field is available even without an API key. Enter `tv/124` for a TV series or `movie/567` for a movie, using its numeric TMDB ID (for TV, use the series ID, not a season or episode ID). Leave it blank for no link. The link stays fixed during upload retries; use **Start over** to change it. Invalid references block uploads but do not block downloads.

The upload sends `tmdbId` as `MOVIE_<id>` or `TV_<id>`, matching the format used by [McBaws/comp](https://github.com/McBaws/comp/blob/main/comp.py). Live linking remains unverified because direct inspection of the slow.pics form was blocked.

## Selection and transfers

On page load, a small startup step registers four Tampermonkey menu commands and reads whether the three API keys are configured. It does not scan images, create page UI, read cookies, or make network requests. **Select comparison images** launches the picker; thumbnail previews can then load images. Original-image resolution and upload requests start only when you choose an output action. Tampermonkey may ask to allow an unfamiliar image host.

Full-image links and standard host-page image metadata take precedence over thumbnails. Small URL resolvers handle ImgBB, img4k, Pixhost (pixhost.cc, pixhost.to, and pixho.st), and proxy/redirect URLs; page detection does not use tracker-specific selectors. Pixhost pages use their displayed full-size image; thumbnail URLs are also resolved to originals. Original bytes and image formats are preserved, and slow.pics image optimization is disabled. Known unresolved thumbnails, invalid image responses, and failed uploads produce errors.

Transfers run sequentially. **Cancel transfer** stops further requests; completed downloads remain saved. After an interrupted slow.pics upload, **Retry upload** resumes the same collection in the open dialog. Its configuration stays locked until **Start over**. Closing the dialog, navigating away, or starting over discards local retry state; an incomplete remote collection may remain. A timeout during collection creation can also leave an unconfirmed collection. No remote collections are automatically deleted.

Downloads are individual files in the browser's download directory. With slow.pics selected, names follow its automatic grouping format: `Source0001.png`, `Encode0001.png`, `Source0002.png`, `Encode0002.png`. The column name comes first and the shared comparison number is padded to at least four digits. The collection title is not part of filenames. Comparison uploads use the same filenames and comparison numbers.

Filename-unsafe characters become underscores. A column ending in a digit gets an underscore before the frame number (`x265_0001.png`) to keep its digits separate from the comparison number. Names that collide after sanitizing, including case-only differences, must be edited before downloading. Use an empty destination for each set. In Tampermonkey's browser download mode, existing filename conflicts prompt instead of silently adding a suffix that breaks grouping. Failed or cancelled downloads leave an incomplete set that needs to be completed before importing into slow.pics. Completed slow.pics uploads display a comparison link with **Copy link** and **Copy BBCode** buttons. **Copy BBCode** fetches the completed comparison page once, validates its rows and column names against this upload, and copies this format:

```text
[url=https://slow.pics/c/example]GroupA vs GroupB | Slowpoke Pics[/url]
[comparison=GroupA, GroupB]
https://i.slow.pics/example-a.png
https://i.slow.pics/example-b.png
[/comparison]
```

All rows appear inside one comparison block, ordered row by row, with each row's images in column order. This also applies when the original selection used **Column by column**. Column names containing brackets, commas or line breaks cannot be represented by this format. The standalone image-width setting does not affect comparison BBCode.

The generated BBCode is shown in a selectable text field and cached while the dialog stays open. If clipboard access is denied, copy it manually. A failed or cancelled lookup keeps the completed upload and comparison link; click **Copy BBCode** to retry only the lookup. Rate limits still apply, and no images are reuploaded. Page parsing was checked against saved HTML and mocked responses; no live slow.pics requests were made during development.

The script reads accessible `<img>` elements, including hidden/lazy images already in the DOM. It does not extract canvas images, inaccessible frames, raw BBCode, or images that a site has not yet created. Open site content before invoking it when needed. Unknown image sizes are retained, so decorative images can occasionally need deselection. Headings and grouping are suggestions to review, especially when a page contains several comparisons or no heading.

## Upload diagnostics

Version 1.1.0 reuses an existing slow.pics CSRF cookie before fetching its upload page. Slow.pics requests explicitly use its first-party cookie partition, browser-managed cookies, and the upload page's Referer/Origin. CSRF cookies and page metadata use their respective CSRF headers. Slow.pics credentials are never copied to image hosts, and the script does not override your browser's User-Agent.

A 403 alone does not identify whether authentication, CSRF validation, or an access challenge failed. Expand **Debug log** and choose **Copy debug log** to capture the failing method and endpoint (`GET /comparison`, `POST /upload/comparison`, or `POST /upload/image`). The same entries appear in the page console under `[comps-rehost]`. Logs include status, response type, a coarse error category, token source/presence, and userscript-manager version. They omit cookie/token values, request/response bodies, collection names, image filenames, URL queries, and image paths. Logs stay in memory and are not uploaded.

403 responses, 429 rate limits, and detected access challenges stop the transfer immediately, including image-host fallback attempts and subsequent downloads. The script does not retry automatically. A server's `Retry-After` is respected for further requests to that host while the dialog remains open. Check [slow.pics/comparison](https://slow.pics/comparison) in its own tab if login or normal access needs attention; do not repeatedly retry if access is blocked. A 403 can still persist because of a server-side block or userscript-manager cookie behavior. Share the debug log to distinguish these cases.

The integration uses slow.pics' website upload endpoints, which can change. Automated tests mock all transfer responses and do not contact slow.pics. Live upload compatibility remains unverified.

## Tests

Run `npm ci`, then `npm test` (or `node --test tests/*.test.cjs`). Tests run entirely in Node using jsdom; no Chrome or other browser is launched. External resources are not loaded, and image decoding, dialogs, and transfer APIs are mocked. Tests cover all three standalone upload payloads, key isolation, partial results and retries, cancellation, rate limits, mode switching, downloads, and persistent BBCode width. Sanitized examples are embedded in the tests; when `tmp/comp-examples/ex1.html` through `ex10.html` and `ex9_pixhost.html` are present, those samples are checked too.

Before release, manually check the native Tampermonkey menu and key prompt, absence of page UI and network requests before launching the picker, and an actual upload and download. Node DOM tests do not verify native image decoding, dialog behavior, userscript-manager permissions, browser-managed sessions, or the live slow.pics service.

The original reference userscript and supplied HTML examples are kept locally in `tmp/`, which is ignored by Git.
