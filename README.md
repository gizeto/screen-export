# comps-rehost

A userscript for selecting images, uploading comparisons to slow.pics, rehosting images on PTScreens, ImgBB or Pixhost, and downloading originals.

Install [comps-rehost.user.js](comps-rehost.user.js) in **Chrome with Tampermonkey 5.4.6226 or newer**. Enable Tampermonkey's downloads permission and allow the ZIP extension in its download settings.

## Usage

1. Open Tampermonkey's menu and choose **Select comparison images**.
2. Click an image area. Use **Expand to parent** or **Choose another area** to adjust the selection.
3. Click images to toggle them; Shift-click selects a range.
4. Choose a **Destination**, then upload or **Download originals**.

For **slow.pics**, review the suggested collection and column names. Choose **Row by row** or **Column by column** to match the page, and check the preview. Every column must have the same number of images. Collections are unlisted unless **Public on slow.pics** is checked.

For **PTScreens** or **ImgBB**, set the corresponding API key in Tampermonkey's menu. **Pixhost** needs no key. Standalone uploads accept any image count and follow page order. Results include copyable BBCode; **BBCode image width** changes its formatting without resizing or reuploading images.

**Download originals (ZIP)** saves one `originals.zip`, preserving original bytes and formats. Inside it, comparison filenames use the column name and a shared frame number (`GroupA0001.png`, `GroupB0001.png`); standalone filenames use `Image0001.png`, etc. Column names must produce distinct filenames. All images must be fetched successfully before saving. Archives are built in memory and must be smaller than 4 GiB; use smaller selections for large sets.

## Optional TMDB linking

Enter `movie/123` or `tv/456` in **TMDB id**, or configure a **TMDB API key** in Tampermonkey's menu to search by title. Searches start only when requested. Submit an empty API-key prompt to clear a saved key.

## Transfers and troubleshooting

- Transfers run sequentially. **Cancel transfer** stops further requests. **Retry upload** resumes an interrupted upload while the dialog stays open; an unconfirmed upload may create a duplicate on retry.
- **Start over**, closing the dialog or leaving the page discards retry state. Remote uploads are not deleted.
- Access blocks and rate limits stop transfers. Check normal access to the host before retrying. **Debug log → Copy debug log** provides diagnostics without API keys, cookies or image paths.
- Images must exist as accessible `<img>` elements. Open collapsed content first and review automatic selection and column suggestions.

No network requests or image scanning occur before launching the picker. Previews can load afterward; original-image requests begin with an upload or download action. Tampermonkey may request permission for image hosts. Live upload compatibility is not covered by automated tests.

## Development

Run `npm ci`, then `node --test tests/*.test.cjs`. Tests use Node and jsdom with mocked browser APIs and transfers; no browser or live hosts are used. Local reference files belong in the Git-ignored `tmp/` directory. See [AGENTS.md](AGENTS.md) for development rules.
