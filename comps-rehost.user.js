// ==UserScript==
// @name         comps-rehost
// @namespace    https://github.com/gizeto
// @version      1.1.0
// @description  Select nearby comparison images, upload to slow.pics, or download originals on demand.
// @author       gizeto
// @match        http://*/*
// @match        https://*/*
// @run-at       context-menu
// @sandbox      DOM
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_cookie
// @grant        GM_info
// @connect      self
// @connect      slow.pics
// @connect      ibb.co
// @connect      img4k.net
// @connect      *
// ==/UserScript==

(() => {
    'use strict';

    const HOST_ID = 'comps-rehost-dialog';
    const SLOW = 'https://slow.pics';
    const existing = document.getElementById(HOST_ID);
    if (existing) {
        existing.dispatchEvent(new Event('comps-rehost-focus'));
        return;
    }
    const diagnostics = [];
    const retryAfter = new Map();
    let requestNumber = 0;

    function debug(event, details = {}) {
        // Call sites supply only diagnostic metadata, never bodies, cookie/token values or filenames.
        const line = JSON.stringify({ time: new Date().toISOString(), event, ...details });
        diagnostics.push(line);
        if (diagnostics.length > 200) diagnostics.shift();
        debugOutput.textContent = diagnostics.join('\n');
        console.info('[comps-rehost]', line);
    }

    function requestLabel(url) {
        const parsed = new URL(url);
        return parsed.origin + (parsed.origin === SLOW && ['/comparison', '/upload/comparison', '/upload/image'].includes(parsed.pathname)
            ? parsed.pathname : '/[redacted]');
    }

    function responseHeader(response, name) {
        return (response.responseHeaders || '').split(/\r?\n/)
            .find(line => line.slice(0, line.indexOf(':')).toLowerCase() === name.toLowerCase())
            ?.slice(name.length + 1).trim() || '';
    }

    async function responseInfo(response) {
        const mime = responseHeader(response, 'content-type').split(';')[0].trim().toLowerCase();
        const text = typeof response.responseText === 'string' ? response.responseText.slice(0, 16384)
            : response.response instanceof Blob && response.status >= 400 ? await response.response.slice(0, 16384).text() : '';
        let category = 'http';
        if (responseHeader(response, 'cf-mitigated') === 'challenge' || /<title>\s*Just a moment|\b_cf_chl_opt\b/i.test(text)
            || response.status >= 400 && /cf-chl-|challenge-platform/i.test(text)) category = 'challenge';
        else if (response.status === 429) category = 'rate-limit';
        else if (response.status >= 400 && /error\s*(?:code\s*:?\s*)?10(?:15|20)|you (?:have been|are) (?:temporarily )?blocked/i.test(text)) category = 'access-block';
        else if (/(?:invalid|missing|expired)[^\n<]{0,60}(?:csrf|xsrf)|(?:csrf|xsrf)[^\n<]{0,60}(?:invalid|missing|expired|mismatch)/i.test(text)) category = 'csrf';
        else if (response.status === 401 || /\/(?:login|signin)(?:[/?#]|$)/i.test(response.finalUrl || '')) category = 'login';
        return { category, mime: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : 'unknown',
            cloudflare: /cloudflare/i.test(responseHeader(response, 'server')) };
    }

    function httpURL(value, base = document.baseURI) {
        if (!value || !value.trim()) return '';
        try {
            const url = new URL(value, base);
            return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
        } catch { return ''; }
    }

    function unwrapURL(value) {
        let current = httpURL(value);
        for (let depth = 0; current && depth < 4; depth++) {
            const url = new URL(current);
            let nested = ['target', 'url', 'u'].map(key => url.searchParams.get(key))
                .find(candidate => /^https?:\/\//i.test(candidate || ''));
            if (!nested) {
                try { nested = decodeURIComponent(url.search.slice(1)); } catch { break; }
            }
            const next = /^https?:\/\//i.test(nested || '') ? httpURL(nested) : '';
            if (!next || next === current) break;
            current = next;
        }
        return current;
    }

    // Image-host rules only; none of these participate in page-layout detection.
    function originalURL(value) {
        const resolved = unwrapURL(value);
        if (!resolved) return '';
        const url = new URL(resolved);
        if (/^(?:t|i|img)\.hdbits\.org$/.test(url.hostname)) {
            const hash = url.pathname.match(/^\/(?:getimg\/)?([\w-]+)(?:\.jpe?g)?\/?$/i)?.[1];
            if (hash) return `https://img.hdbits.org/getimg/${hash}`;
        }
        if (url.hostname === 'img4k.net' || url.hostname === 'i.ibb.co') {
            url.pathname = url.pathname.replace(/\.(?:md|th)(?=\.[^.]+$)/i, '');
        }
        return url.href;
    }

    function knownThumbnail(url) {
        return /(?:\/thumbs?\/|\.(?:md|th)\.|_t\.)/i.test(new URL(url).pathname);
    }

    function imageInfo(img) {
        const lazy = ['data-src', 'data-original', 'data-lazy-src'].map(key => httpURL(img.getAttribute(key))).find(Boolean);
        const srcset = (img.getAttribute('data-srcset') || img.getAttribute('srcset') || '').split(',')
            .map(part => part.trim().split(/\s+/)).filter(([url]) => httpURL(url))
            .sort((a, b) => (parseFloat(b[1]) || 1) - (parseFloat(a[1]) || 1));
        const preview = httpURL(img.currentSrc) || httpURL(img.getAttribute('src')) || lazy || httpURL(srcset[0]?.[0]);
        const source = httpURL(srcset[0]?.[0]) || lazy || preview;
        if (!source || /\.svg(?:[?#]|$)/i.test(source)) return null;
        const width = img.naturalWidth || Number(img.getAttribute('width'));
        const height = img.naturalHeight || Number(img.getAttribute('height'));
        if (!lazy && !srcset.length && width > 0 && height > 0 && width <= 64 && height <= 64) return null;
        const href = img.closest('a[href]')?.getAttribute('href');
        return { node: img, preview, source, link: href && !href.startsWith('#') ? httpURL(href) : '' };
    }

    function columnNames(text) {
        let line = text.replace(/\s+/g, ' ').trim();
        if (line.length > 300 || /https?:\/\/|\[\/?[a-z]+(?:=|\])/i.test(line)) return null;
        line = line.replace(/^[\s=\[\]_-]+|[\s=\[\]_:-]+$/g, '');
        const names = line.split(/\bvs\.?(?=\s|$)/i).map(name => name.trim());
        return names.length >= 2 && names.every(name => name && name.length <= 80) ? names : null;
    }

    function scan(root, target) {
        const images = [], headings = [];
        let text = '', start = 0, position = 0, targetPosition = 0;
        const flush = () => {
            const names = columnNames(text);
            if (names) headings.push({ names, position: start });
            text = '';
        };
        const visit = node => {
            const here = ++position;
            if (node === target) targetPosition = here;
            if (node.nodeType === Node.TEXT_NODE) {
                if (!text.trim() && node.textContent.trim()) start = here;
                text += node.textContent;
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            if (node.id === HOST_ID || /^(SCRIPT|STYLE|TEMPLATE|PRE|CODE|TEXTAREA|BUTTON|INPUT|SELECT|NOSCRIPT)$/.test(node.tagName)) {
                flush();
                return;
            }
            const boundary = /^(BR|IMG|DIV|P|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|FIELDSET|CENTER|TABLE|TR|TD|TH|UL|OL|LI|FIGURE|FIGCAPTION|H[1-6])$/.test(node.tagName);
            if (boundary) flush();
            if (node.tagName === 'IMG') {
                const item = imageInfo(node);
                if (item) images.push({ ...item, position: here });
            } else {
                for (const child of node.childNodes) visit(child);
            }
            if (boundary) flush();
        };
        visit(root);
        flush();
        return { images, headings, targetPosition };
    }

    function detect(target) {
        let fallback;
        for (let root = target; root && root !== document.body && root !== document.documentElement; root = root.parentElement) {
            const found = scan(root, target);
            if (found.images.length < 2) continue;
            fallback ||= { root, images: found.images, names: [] };
            let index = found.headings.findLastIndex(heading => heading.position <= found.targetPosition);
            if (root === target && index < 0) index = 0;
            const heading = found.headings[index];
            if (!heading) continue;
            const end = found.headings[index + 1]?.position ?? Infinity;
            const images = found.images.filter(item => item.position > heading.position && item.position < end);
            if (images.length >= 2) return { root, images, names: heading.names };
        }
        return fallback;
    }

    function selectRange(selected, index, anchor, shift) {
        if (shift && anchor !== null) {
            for (let i = Math.min(index, anchor); i <= Math.max(index, anchor); i++) selected.add(i);
            return anchor;
        }
        if (selected.has(index)) selected.delete(index);
        else selected.add(index);
        return index;
    }

    const abortError = () => new DOMException('Cancelled', 'AbortError');
    const checkAbort = signal => { if (signal.aborted) throw abortError(); };

    function transfer(api, options, signal) {
        return new Promise((resolve, reject) => {
            checkAbort(signal);
            let handle, settled = false;
            const finish = (error, response) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
                if (error) reject(error);
                else resolve(response);
            };
            const cancel = () => { finish(abortError()); handle?.abort?.(); };
            const timer = setTimeout(() => {
                finish(new Error('Request timed out. Retry when the host is reachable.'));
                handle?.abort?.();
            }, 120000);
            signal.addEventListener('abort', cancel, { once: true });
            try {
                handle = api({ ...options,
                    onload: response => finish(null, response),
                    onerror: error => finish(new Error(error?.error || 'Network request failed. Check host access in Tampermonkey.')),
                    ontimeout: () => finish(new Error('Request timed out.')),
                    onabort: () => finish(abortError())
                });
            } catch (error) { finish(error); }
        });
    }

    async function request(url, options, signal) {
        if (!httpURL(url)) throw new Error('Only HTTP(S) image URLs are supported.');
        checkAbort(signal);
        const origin = new URL(url).origin;
        const wait = Math.ceil(((retryAfter.get(origin) || 0) - Date.now()) / 1000);
        if (wait > 0) {
            debug('request-deferred', { target: requestLabel(url), waitSeconds: wait });
            throw Object.assign(new Error(`${new URL(url).hostname}: wait ${wait}s as requested by the host before retrying.`), { stopTransfer: true });
        }
        const id = ++requestNumber;
        const method = options.method || 'GET';
        const target = requestLabel(url);
        debug('request', { id, method, target, csrf: !!(options.headers?.['X-XSRF-TOKEN'] || options.headers?.['X-CSRF-TOKEN']),
            slowPicsCookies: options.cookiePartition?.topLevelSite === SLOW && options.anonymous === false });
        let response;
        try { response = await transfer(GM_xmlhttpRequest, { method: 'GET', url, ...options }, signal); }
        catch (error) {
            debug('request-failed', { id, method, target, category: error.name === 'AbortError' ? 'cancelled' : 'network-or-timeout' });
            throw error;
        }
        checkAbort(signal);
        const info = await responseInfo(response);
        debug('response', { id, method, target, status: response.status, ...info,
            redirected: !!response.finalUrl && response.finalUrl !== url });
        if (response.status < 200 || response.status >= 300 || ['challenge', 'access-block', 'login'].includes(info.category)) {
            const delay = responseHeader(response, 'retry-after');
            const until = /^\d+$/.test(delay) ? Date.now() + Number(delay) * 1000 : Date.parse(delay);
            if (Number.isFinite(until) && until > Date.now()) retryAfter.set(origin, until);
            const stopTransfer = [403, 429].includes(response.status) || ['challenge', 'access-block', 'rate-limit'].includes(info.category);
            const hint = {
                challenge: 'An access challenge was returned. Stop here and check the site in its own tab; the script will not solve challenges or retry automatically.',
                'access-block': 'The host blocked access. Stop requests and check access with the host before retrying.',
                'rate-limit': 'The host rate-limited the request. Stop requests and wait before retrying.',
                csrf: 'The host rejected the CSRF token. Refresh the host page in your logged-in tab before a manual retry.',
                login: 'The request did not reach a logged-in session. Check the host in its own tab.',
                http: `The reason is unconfirmed. See Debug log for the failed endpoint.${response.status === 403 ? ' Do not repeatedly retry a 403.' : ''}`
            }[info.category];
            throw Object.assign(new Error(`${method} ${target}: HTTP ${response.status}. ${hint}`), { stopTransfer, status: response.status });
        }
        if (response.finalUrl && !httpURL(response.finalUrl)) throw new Error('Unsupported redirect.');
        return response;
    }

    function slowRequest(path, options, signal) {
        return request(`${SLOW}${path}`, { ...options, anonymous: false, cookiePartition: { topLevelSite: SLOW },
            headers: { Accept: path === '/comparison' ? 'text/html' : 'application/json, text/plain, */*',
                Referer: `${SLOW}/comparison`, ...(options.method === 'POST' ? { Origin: SLOW } : {}), ...options.headers } }, signal);
    }

    function inertHTML(html) {
        const template = document.createElement('template');
        template.innerHTML = html;
        return template.content;
    }

    async function imageFile(blob, signal) {
        const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
        const ascii = String.fromCharCode(...bytes);
        let format;
        if (bytes[0] === 137 && ascii.slice(1, 4) === 'PNG') format = ['png', 'image/png'];
        else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) format = ['jpg', 'image/jpeg'];
        else if (/^GIF8[79]a/.test(ascii)) format = ['gif', 'image/gif'];
        else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') format = ['webp', 'image/webp'];
        else if (ascii.startsWith('BM')) format = ['bmp', 'image/bmp'];
        if (!format) throw new Error('Response is not a supported image (PNG, JPEG, WebP, GIF, BMP).');
        const file = new Blob([blob], { type: format[1] });
        let bitmap;
        try { bitmap = await createImageBitmap(file); }
        catch { throw new Error('The image is damaged or could not be decoded.'); }
        bitmap.close();
        checkAbort(signal);
        return { blob: file, extension: format[0] };
    }

    async function fetchOriginal(item, signal) {
        const candidates = [...new Set([item.link, item.source].map(originalURL).filter(Boolean))];
        let lastError = new Error('No original image URL found.');
        for (let url of candidates) {
            try {
                const visited = new Set();
                for (let depth = 0; depth < 3; depth++) {
                    checkAbort(signal);
                    if (visited.has(url) || knownThumbnail(url)) throw new Error('Could not resolve the original; refusing a known thumbnail.');
                    visited.add(url);
                    const response = await request(url, { responseType: 'blob' }, signal);
                    if (response.finalUrl && knownThumbnail(response.finalUrl)) throw new Error('The host redirected to a thumbnail; the original is unavailable.');
                    const blob = response.response;
                    const prefix = await blob.slice(0, 256).text();
                    if (/html/i.test(blob.type) || /^\s*(?:<!doctype|<html|<head|<meta)/i.test(prefix)) {
                        const html = inertHTML(await blob.text());
                        const meta = html.querySelector('meta[property="og:image:secure_url"]')
                            || html.querySelector('meta[property="og:image"]')
                            || html.querySelector('link[rel="image_src"]');
                        const next = originalURL(httpURL(meta?.getAttribute('content') || meta?.getAttribute('href'), response.finalUrl || url));
                        if (!next) throw new Error('Host page has no original-image metadata. Check access on the image host or deselect this image.');
                        url = next;
                    } else {
                        return await imageFile(blob, signal);
                    }
                }
                throw new Error('Too many image-page redirects.');
            } catch (error) {
                if (error.name === 'AbortError' || error.stopTransfer) throw error;
                lastError = error;
            }
        }
        throw lastError;
    }

    async function slowToken(signal) {
        // Reuse the logged-in tab's token before making any request to slow.pics.
        for (const partitionKey of [{ topLevelSite: SLOW }, null]) {
            try {
                const cookies = await transfer(options => {
                    GM_cookie.list({ url: `${SLOW}/`, name: 'XSRF-TOKEN', ...(partitionKey ? { partitionKey } : {}) }, (values, error) => {
                        if (error) options.onerror({ error });
                        else options.onload(values || []);
                    });
                }, {}, signal);
                checkAbort(signal);
                const value = cookies.find(entry => entry.name === 'XSRF-TOKEN' && entry.value)?.value;
                if (value) {
                    debug('csrf-ready', { source: partitionKey ? 'partitioned-cookie' : 'cookie' });
                    return { value: decodeURIComponent(value), header: 'X-XSRF-TOKEN' };
                }
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                debug('csrf-cookie-unavailable', { partitioned: !!partitionKey });
            }
        }
        const response = await slowRequest('/comparison', {}, signal);
        const cookie = response.responseHeaders?.match(/(?:^|\n)set-cookie:\s*XSRF-TOKEN=([^;\r\n]+)/i)?.[1];
        if (cookie) {
            debug('csrf-ready', { source: 'response-cookie' });
            return { value: decodeURIComponent(cookie.replace(/^"|"$/g, '')), header: 'X-XSRF-TOKEN' };
        }
        const html = inertHTML(response.responseText || '');
        const token = html.querySelector('meta[name="csrf-token"], meta[name="_csrf"]')?.getAttribute('content')
            || html.querySelector('input[name="_token"], input[name="_csrf"]')?.getAttribute('value');
        if (token) {
            const declaredHeader = html.querySelector('meta[name="_csrf_header"]')?.getAttribute('content');
            debug('csrf-ready', { source: 'page-metadata' });
            return { value: token, header: declaredHeader === 'X-XSRF-TOKEN' ? declaredHeader : 'X-CSRF-TOKEN' };
        }
        debug('csrf-missing');
        throw new Error('No slow.pics session token. Open slow.pics/comparison, finish login or any challenge, then retry.');
    }

    function comparisonFields(job) {
        const data = new FormData();
        for (const [key, value] of Object.entries({ collectionName: job.title, public: String(job.public),
            hentai: 'false', 'optimize-images': 'false', browserId: job.browserId })) data.append(key, value);
        for (let row = 0; row < job.items.length / job.names.length; row++) {
            data.append(`comparisons[${row}].name`, String(row + 1).padStart(4, '0'));
            job.names.forEach((name, col) => data.append(`comparisons[${row}].imageNames[${col}]`, name));
        }
        return data;
    }

    function browserID() {
        // getRandomValues also works on HTTP pages; randomUUID requires a secure context.
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    }

    async function upload(job, signal, status) {
        requireCompleteRows(job.items, job.names);
        const prefixes = fileColumns(job.names);
        status('Connecting to slow.pics…');
        const token = await slowToken(signal);
        const headers = { [token.header]: token.value };
        if (!job.collection) {
            status('Creating comparison…');
            const response = await slowRequest('/upload/comparison', { method: 'POST', headers, data: comparisonFields(job) }, signal);
            let collection;
            try { collection = JSON.parse(response.responseText); }
            catch { throw new Error('slow.pics did not return a comparison. Open slow.pics/comparison to check login or a challenge.'); }
            const rows = job.items.length / job.names.length;
            if (typeof collection.collectionUuid !== 'string' || !collection.collectionUuid
                || !/^[\w-]+$/.test(collection.key || '') || !Array.isArray(collection.images)
                || collection.images.length !== rows || !collection.images.every(row => Array.isArray(row)
                    && row.length === job.names.length && row.every(id => typeof id === 'string' && id))
                || new Set(collection.images.flat()).size !== job.items.length) {
                throw new Error('Unexpected slow.pics comparison response. No images were uploaded.');
            }
            job.collection = collection;
        }
        const ids = job.collection.images.flat();
        for (; job.done < job.items.length; job.done++) {
            checkAbort(signal);
            const current = `${job.done + 1}/${job.items.length}`;
            status(`Fetching original ${current}…`);
            job.pending ||= await fetchOriginal(job.items[job.done], signal);
            const data = new FormData();
            data.append('collectionUuid', job.collection.collectionUuid);
            data.append('imageUuid', ids[job.done]);
            data.append('browserId', job.browserId);
            data.append('file', job.pending.blob, filename(job.done, prefixes, job.pending.extension));
            status(`Uploading image ${current}…`);
            const response = await slowRequest('/upload/image', { method: 'POST', headers, data }, signal);
            if (response.responseText?.trim() !== 'OK') throw new Error(`slow.pics did not accept image ${current}. Retry to resume this collection.`);
            job.pending = null;
        }
        return `${SLOW}/c/${job.collection.key}`;
    }

    function fileColumns(names) {
        const prefixes = names.map(name => {
            const safe = name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().slice(0, 80).replace(/[. ]+$/g, '') || 'Column';
            // Keep digits in names such as x265 separate from the trailing comparison number.
            return /\d$/.test(safe) ? `${safe}_` : safe;
        });
        if (new Set(prefixes.map(name => name.toLowerCase())).size !== prefixes.length) {
            throw new Error('Column names produce identical filenames. Give each column a distinct name.');
        }
        return prefixes;
    }

    function filename(index, prefixes, extension) {
        return `${prefixes[index % prefixes.length]}${String(Math.floor(index / prefixes.length) + 1).padStart(4, '0')}.${extension}`;
    }

    function requireCompleteRows(items, names) {
        if (!items.length || !names.length || items.length % names.length) {
            throw new Error('Every column must have the same number of images. Select complete rows before uploading or downloading.');
        }
    }

    async function download(items, names, signal, status) {
        requireCompleteRows(items, names);
        const prefixes = fileColumns(names);
        let done = 0;
        const failures = [];
        for (let i = 0; i < items.length; i++) {
            try {
                checkAbort(signal);
                status(`Downloading ${i + 1}/${items.length} — ${done} saved, ${failures.length} failed…`);
                const file = await fetchOriginal(items[i], signal);
                await transfer(GM_download, { url: file.blob, name: filename(i, prefixes, file.extension),
                    saveAs: false, conflictAction: 'prompt' }, signal);
                done++;
            } catch (error) {
                if (error.name === 'AbortError') {
                    status(`Cancelled — ${done} saved, ${failures.length} failed, ${items.length - done - failures.length} not completed.`);
                    return;
                }
                failures.push(`Image ${i + 1}: ${error.message}`);
                if (error.stopTransfer) {
                    status(`Stopped — ${done} saved, ${failures.length} failed, ${items.length - done - failures.length} not completed.\n${failures.join('\n')}\nThe set is incomplete; do not import it yet.`);
                    return;
                }
            }
        }
        status(`${done} saved, ${failures.length} failed.${failures.length ? '\n' + failures.join('\n') + '\nThe set is incomplete; do not import it yet.' : ''}`);
    }

    function element(tag, properties = {}, ...children) {
        const node = Object.assign(document.createElement(tag), properties);
        node.append(...children);
        return node;
    }
    const button = (text, click) => element('button', { type: 'button', textContent: text, onclick: click });
    const lifetime = new AbortController();
    const state = { root: null, images: [], selected: new Set(), anchor: null, picker: null, active: null, job: null };
    const host = element('div', { id: HOST_ID });
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = element('style', { textContent: `
        :host { all: initial; }
        * { box-sizing: border-box; }
        dialog, .picker { color: #eee; background: #202329; font: 14px/1.5 system-ui, sans-serif; border: 1px solid #626873; border-radius: 8px; padding: 16px; }
        dialog { width: min(1100px, 94vw); max-height: 92vh; overflow: auto; }
        dialog::backdrop { background: #0009; }
        .picker { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 2147483647; box-shadow: 0 4px 20px #0008; }
        [hidden] { display: none !important; }
        h2, p { margin: 0 0 10px; }
        fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }
        button, input { font: inherit; color: inherit; background: #303640; border: 1px solid #7d8796; border-radius: 4px; padding: 5px 9px; }
        button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
        button:focus-visible, input:focus-visible { outline: 2px solid #76bcff; outline-offset: 2px; }
        input[type=number] { width: 72px; } input[type=checkbox] { accent-color: #76bcff; }
        .controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
        .names input { width: 155px; }
        .grid { display: grid; gap: 8px; margin-bottom: 14px; }
        .candidates { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); max-height: 35vh; overflow: auto; }
        .image { min-width: 0; padding: 4px; } .image[aria-pressed=true] { border: 2px solid #76bcff; background: #294c70; }
        img { display: block; width: 100%; height: 85px; object-fit: contain; background: #111; }
        .preview { overflow: auto; } .preview .grid { min-width: min-content; } .preview figure { margin: 0; min-width: 110px; }
        figcaption { overflow-wrap: anywhere; } .status { white-space: pre-wrap; overflow-wrap: anywhere; }
        a { color: #9cceff; }
    ` });
    const picker = element('div', { className: 'picker', hidden: true }, 'Click the comparison area. Escape cancels. ', button('Cancel', close));
    const dialog = element('dialog');
    const settings = element('fieldset');
    const title = element('input', { value: 'Comparison', ariaLabel: 'Collection name' });
    const columns = element('input', { type: 'number', min: '1', value: '2', ariaLabel: 'Number of columns' });
    const publicInput = element('input', { type: 'checkbox', checked: true });
    const names = element('div', { className: 'controls names' });
    const scope = element('p');
    const candidates = element('div', { className: 'grid candidates' });
    const summary = element('p');
    const preview = element('div', { className: 'grid' });
    const status = element('p', { className: 'status', role: 'status' });
    const debugOutput = element('pre', { style: 'max-height: 180px; overflow: auto; white-space: pre-wrap;' });
    const debugPanel = element('details', {}, element('summary', { textContent: 'Debug log' }),
        button('Copy debug log', async () => {
            try { await navigator.clipboard.writeText(diagnostics.join('\n')); }
            catch { status.textContent = 'Clipboard access was denied. Select and copy the debug log below.'; }
        }), debugOutput);
    const result = element('div', { className: 'controls' });
    const expand = button('Expand to parent', expandArea);
    const uploadButton = button('Upload to slow.pics', () => run('upload'));
    const downloadButton = button('Download originals', () => run('download'));
    const cancelButton = button('Cancel transfer', () => state.active?.abort());
    const resetButton = button('Start over', () => {
        state.job = null;
        result.replaceChildren();
        status.textContent = 'Previous remote collections are kept. You can change the selection now.';
        update();
    });
    settings.append(element('div', { className: 'controls' }, expand, button('Choose another area', chooseArea)), scope,
        element('div', { className: 'controls' }, element('label', {}, 'Collection ', title),
            element('label', {}, 'Columns ', columns), element('label', {}, publicInput, ' Public on slow.pics')), names,
        element('p', { textContent: 'Click to toggle · Shift-click to select a range · Consecutive images form each row.' }),
        element('div', { className: 'controls' }, button('Select all', () => {
            state.selected = new Set(state.images.map((_, i) => i)); state.anchor = null; update();
        }), button('Clear', () => { state.selected.clear(); state.anchor = null; update(); })), candidates);
    dialog.append(element('div', { className: 'controls' }, element('h2', { textContent: 'Comparison images' }), button('Close', close)),
        settings, summary, element('div', { className: 'preview' }, preview),
        element('div', { className: 'controls' }, uploadButton, downloadButton, cancelButton, resetButton), status, result, debugPanel,
        element('a', { href: `${SLOW}/comparison`, target: '_blank', rel: 'noopener noreferrer', textContent: 'Open slow.pics (login or access check)' }));
    shadow.append(style, picker, dialog);
    document.documentElement.append(host);

    function countColumns() { return Math.max(1, Math.min(state.images.length || 2, Math.floor(Number(columns.value)) || 2)); }
    function getNames() { return [...names.children].map((input, i) => input.value.trim() || `Column ${i + 1}`); }
    function selectedImages() { return state.images.filter((_, i) => state.selected.has(i)); }

    function updateNames(values = getNames()) {
        columns.value = String(countColumns());
        names.replaceChildren(...Array.from({ length: countColumns() }, (_, i) => element('input', {
            value: values[i] || `Column ${i + 1}`, ariaLabel: `Column ${i + 1} name`, oninput: update
        })));
    }

    function thumbnail(item) {
        return element('img', { src: item.preview, alt: 'Image preview', loading: 'lazy', referrerPolicy: 'no-referrer' });
    }

    function update() {
        const items = selectedImages(), labels = getNames(), n = countColumns();
        const busy = !!state.active;
        let namingError = '';
        try { fileColumns(labels); } catch (error) { namingError = error.message; }
        const invalid = !items.length || items.length % n !== 0 || !!namingError;
        settings.disabled = busy || !!state.job;
        uploadButton.disabled = busy || invalid || state.job?.done === items.length;
        downloadButton.disabled = busy || invalid;
        cancelButton.hidden = !busy;
        resetButton.hidden = !state.job || busy;
        uploadButton.textContent = state.job && state.job.done < state.job.items.length ? 'Retry upload' : 'Upload to slow.pics';
        expand.disabled = !state.root || state.root === document.body;
        [...candidates.children].forEach((node, i) => node.setAttribute('aria-pressed', String(state.selected.has(i))));
        summary.textContent = `${items.length} selected → ${Math.floor(items.length / n)} complete rows × ${n} columns`
            + (items.length % n ? `; ${items.length % n} image(s) in an incomplete row. Every column needs the same number of images.` : '.')
            + (namingError ? ` ${namingError}` : '');
        preview.style.gridTemplateColumns = `repeat(${n}, minmax(110px, 1fr))`;
        preview.replaceChildren(...items.map((item, i) => element('figure', {}, thumbnail(item),
            element('figcaption', { textContent: `${String(Math.floor(i / n) + 1).padStart(4, '0')} · ${labels[i % n]}` }))));
    }

    function showArea(area) {
        state.root = area?.root || null;
        state.images = area?.images || [];
        state.selected.clear();
        state.anchor = null;
        columns.value = String(area?.names.length || 2);
        updateNames(area?.names || []);
        scope.textContent = area ? `${state.images.length} candidate images. Check the selection and column names before uploading.`
            : 'No nearby group of images found. Choose another area; expand hidden content on the site first if necessary.';
        candidates.replaceChildren(...state.images.map((item, i) => {
            const tile = button('', event => {
                event.preventDefault();
                state.anchor = selectRange(state.selected, i, state.anchor, event.shiftKey);
                update();
            });
            tile.className = 'image';
            tile.title = item.link || item.source;
            tile.append(thumbnail(item), String(i + 1));
            return tile;
        }));
        update();
        if (!dialog.open) dialog.showModal();
    }

    function expandArea() {
        if (!state.root) return;
        let root = state.root;
        let all = scan(root, root);
        if (all.images.length === state.images.length && root.parentElement && root !== document.body) {
            root = root.parentElement;
            all = scan(root, root);
        }
        showArea({ root, images: all.images, names: getNames() });
    }

    function chooseArea() {
        if (state.active || state.job) return;
        state.picker?.abort();
        state.picker = new AbortController();
        dialog.close();
        picker.hidden = false;
        const intercept = event => {
            if (event.button !== 0 || event.composedPath().includes(host)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.type !== 'click') return;
            state.picker.abort();
            picker.hidden = true;
            const target = event.target instanceof Element ? event.target : event.target.parentElement;
            showArea(detect(target));
        };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            window.addEventListener(type, intercept, { capture: true, signal: state.picker.signal });
        }
    }

    async function run(kind) {
        if (state.active) return;
        const items = selectedImages(), labels = getNames();
        try { requireCompleteRows(items, labels); fileColumns(labels); }
        catch (error) { status.textContent = error.message; return; }
        const controller = new AbortController();
        state.active = controller;
        if (kind === 'upload') result.replaceChildren();
        const report = message => { status.textContent = message; };
        debug('transfer-start', { kind, images: items.length, columns: labels.length, completed: kind === 'upload' ? state.job?.done || 0 : 0 });
        try {
            if (kind === 'upload') {
                state.job ||= { items, names: labels, title: title.value.trim() || 'Comparison', public: publicInput.checked,
                    browserId: browserID(), done: 0, collection: null, pending: null };
                update();
                const url = await upload(state.job, controller.signal, report);
                report(`Complete — ${state.job.done} images uploaded.`);
                result.append(element('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: url }),
                    button('Copy link', async () => {
                        try { await navigator.clipboard.writeText(url); report('Comparison link copied.'); }
                        catch { report('Clipboard access was denied. Select and copy the displayed link.'); }
                    }));
            } else {
                update();
                await download(items, labels, controller.signal, report);
            }
        } catch (error) {
            const progress = kind === 'upload' && state.job ? ` ${state.job.done}/${state.job.items.length} uploaded.` : '';
            report(`${error.name === 'AbortError' ? 'Cancelled.' : error.message}${progress}`
                + (kind === 'upload' && state.job?.collection ? ' The remote collection is incomplete. After resolving the error, retry upload to resume, or start over to change the selection.' : ''));
        } finally {
            state.active = null;
            if (host.isConnected) update();
        }
    }

    function close() {
        state.active?.abort();
        state.picker?.abort();
        lifetime.abort();
        dialog.close();
        host.remove();
        state.job = null;
    }

    columns.addEventListener('change', () => { updateNames(); update(); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    window.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    }, { capture: true, signal: lifetime.signal });
    host.addEventListener('comps-rehost-focus', () => {
        if (dialog.open) dialog.focus();
        else picker.querySelector('button').focus();
    }, { signal: lifetime.signal });
    debug('ready', { scriptVersion: typeof GM_info === 'object' ? GM_info.script?.version : '1.1.0',
        manager: typeof GM_info === 'object' ? GM_info.scriptHandler : 'unknown',
        managerVersion: typeof GM_info === 'object' ? GM_info.version : 'unknown' });
    chooseArea();
})();
