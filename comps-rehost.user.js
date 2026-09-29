// ==UserScript==
// @name         comps-rehost
// @namespace    https://github.com/gizeto
// @version      1.2.1
// @description  Select images, upload comparisons to slow.pics or originals to PTScreens, ImgBB and Pixhost, or download originals.
// @author       gizeto
// @match        https://*/*
// @run-at       document-end
// @sandbox      DOM
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_cookie
// @grant        GM_info
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      ptscreens.com
// @connect      imgbb.com
// @connect      api.imgbb.com
// @connect      api.pixhost.to
// @connect      self
// @connect      slow.pics
// @connect      api.themoviedb.org
// @connect      ibb.co
// @connect      img4k.net
// @connect      pixhost.cc
// @connect      pixhost.to
// @connect      pixho.st
// @connect      *
// ==/UserScript==

(() => {
    'use strict';

    let refreshOpenSettings = null;
    const keyMenus = new Map();
    const keySettings = { tmdb_api_key: 'TMDB', ptscreens_api_key: 'PTScreens', imgbb_api_key: 'ImgBB' };

    function savedKey(key) {
        const value = GM_getValue(key, '');
        return typeof value === 'string' ? value.trim() : '';
    }

    function registerKeyMenu(key) {
        const label = keySettings[key];
        const id = keyMenus.get(key);
        keyMenus.set(key, GM_registerMenuCommand(`${label} API key: ${savedKey(key) ? 'configured' : 'not set'}`, () => {
            const value = prompt(`Set ${key}. Leave blank to clear the saved key. Cancel keeps the current key.`, '');
            if (value === null) return;
            try { GM_setValue(key, value.trim()); }
            catch { alert(`Could not save the ${label} API key. The previous value is unchanged.`); return; }
            registerKeyMenu(key);
            refreshOpenSettings?.();
        }, id === undefined ? {} : { id }));
    }

    GM_registerMenuCommand('Select comparison images', launch);
    Object.keys(keySettings).forEach(registerKeyMenu);

    function launch() {
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
            const pixhost = url.hostname.match(/^t(\d+)\.(pixhost\.(?:cc|to)|pixho\.st)$/);
            if (pixhost && url.pathname.startsWith('/thumbs/')) {
                url.hostname = `img${pixhost[1]}.${pixhost[2]}`;
                url.pathname = url.pathname.replace(/^\/thumbs\//, '/images/');
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
            // Collapse HTML source whitespace but preserve visible gaps made with &nbsp;.
            let line = text.replace(/[ \t\r\n\f]+/g, ' ').trim();
            if (line.replace(/\s+/g, ' ').length > 300 || /https?:\/\/|\[\/?[a-z]+(?:=|\])/i.test(line)) return null;
            line = line.replace(/^[\s=\[\]_-]+|[\s=\[\]_:-]+$/g, '');
            let parts = line.split(/\bvs\.?(?=\s|$)|\|/i);
            // Spaced hyphens/slashes separate columns; WEB-DL and Source/Filtered stay intact.
            if (parts.length === 1) parts = line.split(/\s+[-/](?=\s|$)/);
            if (parts.length === 1) parts = line.split(',');
            // A single nonbreaking space can belong to a multiword name.
            if (parts.length === 1) parts = line.split(/[ \u00a0]*\u00a0[ \u00a0]*\u00a0[ \u00a0]*/);
            const names = parts.map(name => name.replace(/\s+/g, ' ').trim());
            return names.length >= 2 && names.every(name => name && name.length <= 80) ? names : null;
        }

        function collectionName(pageTitle, labels) {
            const normalized = pageTitle.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
            const resolution = /\b(?:480[pi]|576[pi]|720p|1080[pi]|2160p|4320p)\b/i.exec(normalized);
            let base = 'Comparison';
            if (resolution) {
                const before = normalized.slice(0, resolution.index).trim();
                const season = /\bS(\d{1,2})(?:E\d{1,3})?\b/i.exec(before);
                const beforeSeason = season ? before.slice(0, season.index).trim() : before;
                const year = [...beforeSeason.matchAll(/\b(?:19|20)\d{2}\b/g)].at(-1);
                if (year || season) {
                    const name = beforeSeason.slice(0, year ? year.index : beforeSeason.length)
                        .split(/\bAKA\b/i)[0].replace(/[\s([\]-]+$|^[\s[\]]+/g, '').trim();
                    if (name) base = [name, year?.[0], season && `S${season[1].padStart(2, '0')}`,
                        resolution[0].toLowerCase()].filter(Boolean).join(' ');
                }
            }
            return labels.length ? `${base} - ${labels.join(' vs ')}` : base;
        }

        function suggestedMediaType(pageTitle) {
            const normalized = pageTitle.replace(/[._]/g, ' ');
            return /\b(?:S\d{1,2}(?:E\d{1,3})?|\d{1,2}x\d{2,3}|Season\s+\d{1,2}|Episode\s+\d{1,3})\b/i.test(normalized) ? 'TV' : 'MOVIE';
        }

        function scan(root, target) {
            const images = [], headings = [];
            let text = '', start = 0, position = 0, targetPosition = 0;
            const endHeading = at => {
                const heading = headings.at(-1);
                if (heading) heading.end ??= at;
            };
            const flush = () => {
                const names = columnNames(text);
                const line = text.replace(/\s+/g, ' ').trim();
                // Unrelated text ends a comparison; captions repeating its column names do not.
                if (names || (line && !headings.at(-1)?.names.includes(line))) endHeading(start);
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
                if (node.id === HOST_ID || /^(SCRIPT|STYLE|TEMPLATE|CODE|TEXTAREA|BUTTON|INPUT|SELECT|NOSCRIPT)$/.test(node.tagName)) {
                    flush();
                    return;
                }
                const boundary = /^(BR|IMG|DIV|P|PRE|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|FIELDSET|CENTER|TABLE|TR|TD|TH|UL|OL|LI|FIGURE|FIGCAPTION|H[1-6])$/.test(node.tagName);
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
            let fallback, single;
            for (let root = target; root && root !== document.body && root !== document.documentElement; root = root.parentElement) {
                const found = scan(root, target);
                if (found.images.length === 1) single ||= { root, images: found.images, names: [] };
                if (found.images.length < 2) continue;
                fallback ||= { root, images: found.images, names: [] };
                let index = found.headings.findLastIndex(heading => heading.position <= found.targetPosition);
                if (root === target && index < 0) index = 0;
                const heading = found.headings[index];
                if (!heading) continue;
                const end = heading.end ?? Infinity;
                if (found.targetPosition >= end) continue;
                const images = found.images.filter(item => item.position > heading.position && item.position < end);
                if (images.length >= 2) return { root, images, names: heading.names };
            }
            return fallback || single;
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
                            const pageURL = response.finalUrl || url;
                            // Pixhost advertises thumbnails in Open Graph; its displayed image is the original.
                            const pixhostImage = /^(?:www\.)?(?:pixhost\.(?:cc|to)|pixho\.st)$/.test(new URL(pageURL).hostname)
                                ? html.querySelector('img#image')?.getAttribute('src') : '';
                            const meta = html.querySelector('meta[property="og:image:secure_url"]')
                                || html.querySelector('meta[property="og:image"]')
                                || html.querySelector('link[rel="image_src"]');
                            const next = originalURL(httpURL(pixhostImage, pageURL)
                                || httpURL(meta?.getAttribute('content') || meta?.getAttribute('href'), pageURL));
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

        function tmdbReference(value) {
            const reference = value.trim();
            if (!reference) return '';
            const match = /^(movie|tv)\/(\d+)$/i.exec(reference);
            if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) {
                throw new Error('Enter a TMDB id such as tv/124 or movie/567, or leave it blank.');
            }
            return `${match[1].toUpperCase()}_${Number(match[2])}`;
        }

        async function searchTMDB(type, query, apiKey, signal) {
            if (!['MOVIE', 'TV'].includes(type)) throw new Error('Choose Movie or TV.');
            if (!query.trim()) throw new Error('Enter a title to search for.');
            if (!apiKey.trim()) throw new Error('Set the TMDB API key in the Tampermonkey menu to search.');
            const url = new URL(`https://api.themoviedb.org/3/search/${type.toLowerCase()}`);
            url.searchParams.set('query', query.trim());
            url.searchParams.set('include_adult', 'false');
            const headers = { Accept: 'application/json' };
            url.searchParams.set('api_key', apiKey.trim());
            let response;
            try {
                response = await request(url.href, { headers, anonymous: true }, signal);
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                if (error.status === 401) throw new Error('TMDB rejected the API key. Check the TMDB API key in the Tampermonkey menu.');
                if (error.status === 429 || (retryAfter.get(url.origin) || 0) > Date.now()) throw new Error('TMDB rate limit reached. Wait before searching again.');
                throw new Error(`TMDB search failed${error.status ? ` (HTTP ${error.status})` : ''}. Try again later.`);
            }
            let data;
            try { data = JSON.parse(response.responseText); } catch { throw new Error('TMDB returned an invalid search response.'); }
            if (!Array.isArray(data.results)) throw new Error('TMDB returned an invalid search response.');
            return data.results.filter(item => item && Number.isSafeInteger(item.id) && item.id > 0
                && typeof (type === 'MOVIE' ? item.title : item.name) === 'string').map(item => ({
                id: String(item.id), title: type === 'MOVIE' ? item.title : item.name,
                year: String((type === 'MOVIE' ? item.release_date : item.first_air_date) || '').match(/^\d{4}/)?.[0] || 'Unknown year',
                countries: Array.isArray(item.origin_country) ? item.origin_country.filter(code => typeof code === 'string' && /^[A-Z]{2}$/.test(code)) : [],
                poster: typeof item.poster_path === 'string' && /^\/[\w-]+\.(?:jpg|png|webp)$/i.test(item.poster_path)
                    ? `https://image.tmdb.org/t/p/w92${item.poster_path}` : ''
            }));
        }

        function countryNames(codes) {
            const regions = new Intl.DisplayNames(['en'], { type: 'region' });
            return codes.map(code => regions.of(code)).join(', ') || 'Unknown country';
        }

        async function movieCountries(id, apiKey, signal) {
            const url = new URL(`https://api.themoviedb.org/3/movie/${id}`);
            url.searchParams.set('api_key', apiKey);
            const response = await request(url.href, { headers: { Accept: 'application/json' }, anonymous: true }, signal);
            const data = JSON.parse(response.responseText);
            const codes = Array.isArray(data.origin_country) && data.origin_country.length ? data.origin_country
                : (Array.isArray(data.production_countries) ? data.production_countries.map(country => country?.iso_3166_1) : []);
            return codes.filter(code => typeof code === 'string' && /^[A-Z]{2}$/.test(code));
        }

        function comparisonFields(job) {
            const data = new FormData();
            for (const [key, value] of Object.entries({ collectionName: job.title, public: String(job.public),
                hentai: 'false', 'optimize-images': 'false', browserId: job.browserId })) data.append(key, value);
            if (job.tmdbId) data.append('tmdbId', job.tmdbId);
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

        function comparisonPageURLs(html, job) {
            // The saved slow.pics page embeds JSON in a single-line `var collection = ...;`.
            // Parse the data only: never execute the page's scripts or load its resources.
            const declarations = [...inertHTML(html).querySelectorAll('script:not([src])')]
                .flatMap(script => [...script.textContent.matchAll(/^\s*(?:var|let|const)\s+collection\s*=\s*(\{[^\r\n]*\})\s*;[ \t]*$/gm)]);
            let collection;
            try {
                if (declarations.length !== 1) throw new Error();
                collection = JSON.parse(declarations[0][1]);
            } catch { throw new Error('slow.pics did not return readable comparison data for BBCode.'); }
            const rows = collection?.comparisons;
            const count = job.items.length / job.names.length;
            if (!Array.isArray(rows) || rows.length !== count
                || !(collection.key === job.collection.key || rows.some(row => row?.key === job.collection.key))) {
                throw new Error('The returned slow.pics collection does not match this upload.');
            }
            const urls = [];
            for (let index = 0; index < count; index++) {
                const matching = rows.filter(row => row?.name === String(index + 1).padStart(4, '0'));
                const images = matching[0]?.images;
                if (matching.length !== 1 || !Array.isArray(images) || images.length !== job.names.length
                    || !images.every((image, col) => image?.name === job.names[col]
                        && typeof image.publicFileName === 'string'
                        && /^[\w-]+\.(?:png|jpe?g|webp|gif|bmp|avif)$/i.test(image.publicFileName))) {
                    throw new Error('Could not match all uploaded images to their comparison rows and columns.');
                }
                urls.push(...images.map(image => `https://i.slow.pics/${image.publicFileName}`));
            }
            return urls;
        }

        async function comparisonImageURLs(job, signal) {
            if (!job.collection || job.done !== job.items.length) throw new Error('Finish uploading before copying comparison BBCode.');
            const response = await slowRequest(`/c/${job.collection.key}`, { headers: { Accept: 'text/html' } }, signal);
            return comparisonPageURLs(response.responseText, job);
        }

        function comparisonBBCode(job, urls) {
            if (job.done !== job.items.length || urls.length !== job.items.length
                || urls.some(url => !resultURL(url) || new URL(url).hostname !== 'i.slow.pics')) {
                throw new Error('Could not match all uploaded images to the comparison.');
            }
            if (job.names.some(name => /[\[\],\r\n]/.test(name))) {
                throw new Error('Comparison BBCode requires column names without brackets, commas or line breaks.');
            }
            return [`[url=${SLOW}/c/${job.collection.key}]${job.names.join(' vs ')} | Slowpoke Pics[/url]`,
                `[comparison=${job.names.join(', ')}]`, ...urls, '[/comparison]'].join('\n');
        }

        const imageHosts = {
            ptscreens: { label: 'PTScreens', key: 'ptscreens_api_key', url: 'https://ptscreens.com/api/1/upload' },
            imgbb: { label: 'ImgBB', key: 'imgbb_api_key', url: 'https://api.imgbb.com/1/upload', maxSize: 32 * 1024 * 1024 },
            pixhost: { label: 'Pixhost', url: 'https://api.pixhost.to/images', maxSize: 10 * 1024 * 1024,
                formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'] }
        };

        function hostKey(destination) {
            const config = imageHosts[destination];
            if (!config) throw new Error('Unknown image destination.');
            const key = config.key ? savedKey(config.key) : '';
            if (config.key && !key) throw new Error(`Set the ${config.label} API key in the Tampermonkey menu before uploading.`);
            return key;
        }

        function resultURL(value) {
            if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\[\]\s]/.test(value)) return '';
            return httpURL(value);
        }

        function imageUploadResult(destination, data) {
            let pageUrl, original;
            if (destination === 'pixhost') {
                pageUrl = resultURL(data?.show_url);
                const thumb = resultURL(data?.th_url);
                if (thumb && /^t\d+\.(?:pixhost\.(?:to|cc)|pixho\.st)$/.test(new URL(thumb).hostname)
                    && new URL(thumb).pathname.startsWith('/thumbs/')) original = originalURL(thumb);
            } else {
                const success = destination === 'imgbb' ? data?.success === true : data?.status_code === 200;
                if (success) {
                    pageUrl = resultURL(data.data?.url_viewer);
                    original = resultURL(data.data?.image?.url || (destination === 'imgbb' ? data.data?.url : ''));
                }
            }
            if (!pageUrl || !original) throw new Error(`${imageHosts[destination].label} returned an invalid upload result. Retry may create a duplicate.`);
            return { pageUrl, originalUrl: original };
        }

        async function uploadImage(destination, file, name, nsfw, key, signal) {
            const config = imageHosts[destination];
            if (config.maxSize && file.blob.size > config.maxSize) throw new Error(`${config.label}: image exceeds the ${config.maxSize / 1024 / 1024} MB limit.`);
            if (config.formats && !config.formats.includes(file.blob.type)) throw new Error(`${config.label} does not support ${file.blob.type}. Choose another destination.`);
            const data = new FormData();
            const headers = { Accept: 'application/json' };
            if (destination === 'ptscreens') {
                const bytes = new Uint8Array(await file.blob.arrayBuffer());
                const chunks = [];
                for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
                data.append('image', btoa(chunks.join('')));
                headers['X-API-Key'] = key;
            } else if (destination === 'imgbb') {
                data.append('key', key);
                data.append('image', file.blob, name);
            } else {
                data.append('img', file.blob, name);
                data.append('content_type', nsfw ? '1' : '0');
            }
            checkAbort(signal);
            let response;
            try { response = await request(config.url, { method: 'POST', data, headers, anonymous: true, redirect: 'error' }, signal); }
            catch (error) {
                // Manager network errors can contain URLs or request details. Do not surface credentials.
                if (error.name === 'AbortError' || error.status || error.stopTransfer) throw error;
                throw new Error(`${config.label} upload failed or timed out. Check access before retrying; retry may create a duplicate.`);
            }
            let parsed;
            try { parsed = JSON.parse(response.responseText); }
            catch { throw new Error(`${config.label} returned an invalid upload response. Retry may create a duplicate.`); }
            return imageUploadResult(destination, parsed);
        }

        async function uploadImages(job, signal, status, changed = () => {}) {
            const key = hostKey(job.destination);
            for (; job.done < job.items.length;) {
                checkAbort(signal);
                const current = `${job.done + 1}/${job.items.length}`;
                status(`Fetching original ${current}…`);
                job.pending ||= await fetchOriginal(job.items[job.done], signal);
                status(`Uploading image ${current} to ${imageHosts[job.destination].label}…`);
                const uploaded = await uploadImage(job.destination, job.pending,
                    filename(job.done, ['Image'], job.pending.extension), job.nsfw, key, signal);
                job.results.push(uploaded);
                job.pending = null;
                job.done++;
                changed();
            }
        }

        function validWidth(value) { return value === '' || /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)); }
        function imageBBCode(results, width) {
            if (!validWidth(width)) throw new Error('BBCode width must be blank or a positive integer.');
            return results.map(({ pageUrl, originalUrl }) => `[url=${pageUrl}][img${width ? `=${width}` : ''}]${originalUrl}[/img][/url]`).join(' ');
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

        async function zipArchive(files, signal) {
            // ZIP STORE keeps original image bytes intact; no compression library is needed.
            const limit = 0xffffffff;
            if (files.length >= 0xffff) throw new Error('Too many images for a ZIP archive. Select fewer images.');
            const encoder = new TextEncoder();
            const entries = files.map(file => ({ ...file, nameBytes: encoder.encode(file.name) }));
            let size = 22;
            for (const file of entries) {
                size += 76 + file.nameBytes.length * 2 + file.blob.size;
                if (file.nameBytes.length > 0xffff || file.blob.size >= limit || size >= limit) {
                    throw new Error('ZIP archives must be smaller than 4 GiB. Select fewer images.');
                }
            }
            const table = Uint32Array.from({ length: 256 }, (_, value) => {
                for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
                return value >>> 0;
            });
            const parts = [], directory = [];
            let offset = 0, directorySize = 0;
            for (const file of entries) {
                checkAbort(signal);
                let crc = 0xffffffff;
                for (let start = 0; start < file.blob.size; start += 1024 * 1024) {
                    const bytes = new Uint8Array(await file.blob.slice(start, start + 1024 * 1024).arrayBuffer());
                    checkAbort(signal);
                    for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
                }
                crc = (crc ^ 0xffffffff) >>> 0;
                const local = new Uint8Array(30 + file.nameBytes.length);
                const view = new DataView(local.buffer);
                view.setUint32(0, 0x04034b50, true);
                view.setUint16(4, 20, true); // ZIP 2.0
                view.setUint16(6, 0x0800, true); // UTF-8 filenames
                view.setUint16(12, 0x0021, true); // 1980-01-01
                view.setUint32(14, crc, true);
                view.setUint32(18, file.blob.size, true);
                view.setUint32(22, file.blob.size, true);
                view.setUint16(26, file.nameBytes.length, true);
                local.set(file.nameBytes, 30);
                const central = new Uint8Array(46 + file.nameBytes.length);
                const centralView = new DataView(central.buffer);
                centralView.setUint32(0, 0x02014b50, true);
                centralView.setUint16(4, 20, true);
                central.set(local.subarray(4, 30), 6);
                centralView.setUint32(42, offset, true);
                central.set(file.nameBytes, 46);
                parts.push(local, file.blob);
                directory.push(central);
                offset += local.length + file.blob.size;
                directorySize += central.length;
            }
            const end = new Uint8Array(22);
            const endView = new DataView(end.buffer);
            endView.setUint32(0, 0x06054b50, true);
            endView.setUint16(8, entries.length, true);
            endView.setUint16(10, entries.length, true);
            endView.setUint32(12, directorySize, true);
            endView.setUint32(16, offset, true);
            checkAbort(signal);
            return new Blob([...parts, ...directory, end], { type: 'application/zip' });
        }

        async function download(items, names, signal, status) {
            requireCompleteRows(items, names);
            const prefixes = fileColumns(names);
            const files = [];
            try {
                for (let i = 0; i < items.length; i++) {
                    checkAbort(signal);
                    status(`Fetching original ${i + 1}/${items.length} for ZIP…`);
                    const file = await fetchOriginal(items[i], signal);
                    files.push({ blob: file.blob, name: filename(i, prefixes, file.extension) });
                }
                status(`Building ZIP with ${files.length} images…`);
                const archive = await zipArchive(files, signal);
                status('Saving originals.zip…');
                await transfer(GM_download, { url: archive, name: 'originals.zip',
                    saveAs: false, conflictAction: 'prompt' }, signal);
                status(`Saved originals.zip — ${files.length} images.`);
            } catch (error) {
                status(error.name === 'AbortError' ? 'Cancelled — ZIP download incomplete.'
                    : `Stopped — ZIP download incomplete. ${error.message}`);
            }
        }

        function element(tag, properties = {}, ...children) {
            const node = Object.assign(document.createElement(tag), properties);
            node.append(...children);
            return node;
        }
        const button = (text, click) => element('button', { type: 'button', textContent: text, onclick: click });
        function hint(id, label, text) {
            const trigger = element('button', { type: 'button', className: 'help-icon', textContent: '?', ariaLabel: label });
            trigger.setAttribute('aria-describedby', id);
            return element('span', { className: 'help' }, trigger,
                element('span', { id, className: 'help-text', role: 'tooltip', textContent: text }));
        }
        const lifetime = new AbortController();
        const state = { root: null, images: [], selected: new Set(), anchor: null, picker: null, active: null, job: null, customTitle: false };
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
            h2, h3, p { margin: 0 0 10px; }
            fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }
            button, input, select, textarea { font: inherit; color: inherit; background: #303640; border: 1px solid #7d8796; border-radius: 4px; padding: 7px 10px; }
            button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; }
            button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #76bcff; outline-offset: 2px; }
            input[type=number] { width: 72px; } input[type=checkbox] { accent-color: #76bcff; }
            .controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
            .settings-section { padding: 14px; margin-bottom: 14px; border: 1px solid #424852; border-radius: 6px; background: #252930; }
            .section-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
            .section-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
            .section-header .controls { margin: 0; }
            .field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
            .field-label { color: #c4cbd6; font-size: 12px; font-weight: 500; }
            .field input:not([type=checkbox]), .field select { width: 100%; min-width: 0; }
            .collection-fields { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 16px; }
            .visibility { display: flex; align-items: center; gap: 7px; min-height: 37px; white-space: nowrap; }
            .visibility input { margin: 0; }
            .tmdb-search-fields { display: grid; grid-template-columns: 112px minmax(0, 1fr) auto; align-items: end; gap: 10px; margin-bottom: 12px; max-width: 716px; }
            .tmdb-link-fields { display: grid; grid-template-columns: minmax(0, 1fr) 220px; align-items: start; gap: 16px; max-width: 716px; }
            .tmdb-link-fields:has(.tmdb-result-field[hidden]) { grid-template-columns: minmax(0, 220px); }
            .field-heading { display: flex; align-items: center; gap: 6px; min-height: 22px; }
            .tmdb-status:empty { display: none; }
            .tmdb-status { margin: 10px 0 0; }
            .image-fields { display: grid; grid-template-columns: 80px 190px minmax(0, 1fr); align-items: start; gap: 12px; margin-bottom: 14px; }
            .selection-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
            .selection-toolbar .field-label { margin-right: auto; }
            .dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
            .dialog-header h2 { margin: 0; }
            .close { flex-shrink: 0; width: 32px; height: 32px; padding: 0; border: 0; background: transparent; font-size: 26px; line-height: 1; }
            .help-controls { position: relative; }
            .help { display: inline-flex; position: relative; }
            .help-icon { width: 22px; height: 22px; padding: 0; border-radius: 50%; line-height: 1; cursor: help; }
            .help-text { display: none; position: absolute; top: calc(100% + 6px); left: 0; z-index: 2; width: min(320px, 70vw); padding: 8px 10px; border: 1px solid #7d8796; border-radius: 4px; background: #303640; box-shadow: 0 2px 8px #0006; }
            .help:hover .help-text, .help:focus-within .help-text { display: block; }
            .selection-toolbar .help-text { left: auto; right: 0; }
            .names { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
            .names input { width: 100%; min-width: 0; }
            .tmdb-dropdown { position: relative; width: 480px; max-width: 100%; }
            .tmdb-trigger { width: 100%; text-align: left; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding-right: 28px; }
            .tmdb-dropdown::after { content: '▾'; position: absolute; right: 10px; top: 8px; pointer-events: none; color: #c4cbd6; }
            .tmdb-results { position: absolute; top: 100%; left: 0; z-index: 3; width: 100%; height: 280px; overflow-y: auto; overscroll-behavior: contain; background: #202329; border: 1px solid #7d8796; border-radius: 4px; }
            .tmdb-option { display: flex; align-items: center; gap: 10px; width: 100%; height: 92px; text-align: left; border: 0; border-radius: 0; }
            .tmdb-option[aria-selected=true] { background: #294c70; }
            .tmdb-poster { flex: 0 0 48px; width: 48px; height: 72px; display: flex; align-items: center; justify-content: center; font-size: 11px; text-align: center; background: #111; }
            .tmdb-poster img { width: 48px; height: 72px; object-fit: cover; }
            .tmdb-description { min-width: 0; }
            .tmdb-description span { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
            .tmdb-country { font-size: 12px; color: #c4cbd6; }
            .grid { display: grid; gap: 8px; margin-bottom: 14px; }
            .candidates { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); max-height: 35vh; overflow: auto; }
            .candidates:last-child { margin-bottom: 0; }
            .image { min-width: 0; padding: 4px; } .image[aria-pressed=true] { border: 2px solid #76bcff; background: #294c70; }
            img { display: block; width: 100%; height: 85px; object-fit: contain; background: #111; }
            .preview { overflow: auto; } .preview .grid { min-width: min-content; } .preview figure { margin: 0; min-width: 110px; }
            figcaption { overflow-wrap: anywhere; } .status { white-space: pre-wrap; overflow-wrap: anywhere; }
            textarea { width: 100%; min-height: 110px; resize: vertical; }
            a { color: #9cceff; }
            @media (max-width: 720px) {
                .collection-fields, .tmdb-link-fields { grid-template-columns: minmax(0, 1fr); gap: 10px; }
                .image-fields { grid-template-columns: 80px minmax(0, 1fr); }
                .column-names { grid-column: 1 / -1; }
                .tmdb-search-fields { grid-template-columns: 100px minmax(0, 1fr); }
                .tmdb-search-fields > button { grid-column: 1 / -1; }
                .settings-section { padding: 12px; }
            }
        ` });
        const picker = element('div', { className: 'picker', hidden: true }, 'Click an image area. Escape cancels. ',
            button('Cancel', close));
        const dialog = element('dialog');
        const settings = element('fieldset');
        const field = (label, control) => element('label', { className: 'field' }, element('span', { className: 'field-label', textContent: label }), control);
        const destination = element('select', { ariaLabel: 'Destination', onchange: () => {
            resetTMDBResults(); update();
        } }, ...[['slowpics', 'slow.pics'], ...Object.entries(imageHosts).map(([id, config]) => [id, config.label])]
            .map(([value, textContent]) => element('option', { value, textContent })));
        const nsfw = element('input', { type: 'checkbox', checked: false });
        const nsfwField = element('label', { hidden: true }, nsfw, 'NSFW on Pixhost');
        const keyHint = element('p', { role: 'status', hidden: true });
        const storedWidth = GM_getValue('image_bbcode_width', '');
        const width = element('input', { type: 'text', inputMode: 'numeric', ariaLabel: 'BBCode image width',
            value: typeof storedWidth === 'string' && validWidth(storedWidth) ? storedWidth : '', oninput: () => {
                const valid = validWidth(width.value);
                width.setCustomValidity(valid ? '' : 'Enter a positive integer or leave blank.');
                widthError.textContent = valid ? '' : 'BBCode width must be blank or a positive integer.';
                if (valid) {
                    try { GM_setValue('image_bbcode_width', width.value); }
                    catch { widthError.textContent = 'Could not save BBCode width. This value applies only to this dialog.'; }
                }
                renderImageResults();
            } });
        const widthError = element('p', { role: 'status' });
        const widthSection = element('div', { hidden: true }, field('BBCode image width', width), widthError);
        const bbcode = element('textarea', { readOnly: true, ariaLabel: 'Image BBCode' });
        const copyBBCode = button('Copy BBCode', async () => {
            try { await navigator.clipboard.writeText(bbcode.value); status.textContent = 'BBCode copied.'; }
            catch { status.textContent = 'Clipboard access was denied. Select and copy the BBCode below.'; }
        });
        function renderImageResults() {
            if (!state.job?.results) return;
            const valid = validWidth(width.value);
            bbcode.value = valid ? imageBBCode(state.job.results, width.value) : '';
            copyBBCode.disabled = !valid || !state.job.results.length;
            if (state.job.results.length) result.replaceChildren(bbcode, copyBBCode);
        }
        const title = element('input', { value: 'Comparison', ariaLabel: 'Collection name',
            oninput: () => { state.customTitle = true; } });
        const columns = element('input', { type: 'number', min: '1', value: '2', ariaLabel: 'Number of columns' });
        const imageOrder = element('select', { ariaLabel: 'Image order', onchange: update },
            element('option', { value: 'rows', textContent: 'Row by row' }),
            element('option', { value: 'columns', textContent: 'Column by column' }));
        const publicInput = element('input', { type: 'checkbox', checked: false });
        const storedTMDBKey = GM_getValue('tmdb_api_key', '');
        let tmdbAPIKey = typeof storedTMDBKey === 'string' ? storedTMDBKey.trim() : '';
        let tmdbSearchController = null;
        const tmdbType = element('select', { ariaLabel: 'TMDB media type', onchange: () => {
            tmdbInput.value = ''; resetTMDBResults(); update();
        } },
            element('option', { value: 'MOVIE', textContent: 'Movie' }), element('option', { value: 'TV', textContent: 'TV' }));
        tmdbType.value = suggestedMediaType(document.title);
        const tmdbInput = element('input', { type: 'text', placeholder: 'tv/124 or movie/567',
                ariaLabel: 'TMDB id', oninput: () => { clearTMDBSelection(); update(); } });
        const suggestedTitle = collectionName(document.title, []).replace(/(?:\s+(?:19|20)\d{2})?(?:\s+S\d+)?\s+\d+[pi]$/, '');
        const tmdbQuery = element('input', { ariaLabel: 'Search TMDB by title', placeholder: 'Movie or TV title',
            value: suggestedTitle === 'Comparison' ? '' : suggestedTitle, oninput: resetTMDBResults,
            onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); findTMDB(); } } });
        const tmdbSearchButton = button('Search TMDB', findTMDB);
        const tmdbResults = element('div', { id: 'tmdb-results', className: 'tmdb-results', role: 'listbox', ariaLabel: 'TMDB search results', hidden: true });
        const tmdbResultsButton = button('Search for a title above', () => {
            setTMDBResultsOpen(tmdbResults.hidden);
            if (!tmdbResults.hidden) (tmdbResults.querySelector('[aria-selected=true]') || tmdbResults.firstElementChild)?.focus();
        });
        tmdbResultsButton.className = 'tmdb-trigger';
        tmdbResultsButton.id = 'tmdb-results-trigger';
        tmdbResultsButton.disabled = true;
        tmdbResultsButton.setAttribute('aria-haspopup', 'listbox');
        tmdbResultsButton.setAttribute('aria-controls', tmdbResults.id);
        tmdbResultsButton.setAttribute('aria-expanded', 'false');
        const tmdbDropdown = element('div', { className: 'tmdb-dropdown', onfocusout: event => {
            if (!tmdbDropdown.contains(event.relatedTarget)) setTMDBResultsOpen(false);
        }, onkeydown: event => {
            const options = [...tmdbResults.children];
            if (!options.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            setTMDBResultsOpen(true);
            const index = options.indexOf(event.target);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                : index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            options[next].focus();
        } }, tmdbResultsButton, tmdbResults);
        const tmdbSearchStatus = element('p', { role: 'status', className: 'tmdb-status' });
        const tmdbSearchSection = element('div', { hidden: !tmdbAPIKey },
            element('div', { className: 'tmdb-search-fields' }, field('Media type', tmdbType), field('Title', tmdbQuery), tmdbSearchButton));
        const tmdbResultField = element('div', { className: 'field tmdb-result-field', hidden: !tmdbAPIKey },
            element('label', { className: 'field-label field-heading', htmlFor: tmdbResultsButton.id, textContent: 'Search results' }), tmdbDropdown);
        const tmdbSearchHint = hint('tmdb-search-help', 'TMDB search help',
            'Set the TMDB API key from the Tampermonkey menu to enable title search, or enter a TMDB id manually.');
        tmdbSearchHint.hidden = !!tmdbAPIKey;
        const tmdbError = element('p', { role: 'status', className: 'tmdb-status', hidden: true });
        const names = element('div', { className: 'names', role: 'group', ariaLabel: 'Column names' });
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
        const downloadButton = button('Download originals (ZIP)', () => run('download'));
        const cancelButton = button('Cancel transfer', () => state.active?.abort());
        const resetButton = button('Start over', () => {
            state.job = null;
            result.replaceChildren();
            status.textContent = 'Previous remote uploads are kept. You can change the selection now.';
            update();
        });
        tmdbInput.id = 'tmdb-reference';
        settings.append(
            element('section', { className: 'settings-section' }, field('Destination', destination), nsfwField, keyHint),
            element('section', { className: 'settings-section comparison-only' },
                element('div', { className: 'section-header' }, element('h3', { textContent: 'Collection' })),
                element('div', { className: 'collection-fields' }, field('Collection name', title),
                    element('label', { className: 'visibility' }, publicInput, 'Public on slow.pics'))),
            element('section', { className: 'settings-section comparison-only' },
                element('div', { className: 'section-header' }, element('h3', { textContent: 'TMDB link' })),
                tmdbSearchSection,
                element('div', { className: 'tmdb-link-fields' }, tmdbResultField,
                    element('div', { className: 'field' }, element('div', { className: 'field-heading' },
                        element('label', { className: 'field-label', htmlFor: tmdbInput.id, textContent: 'TMDB id' }), tmdbSearchHint), tmdbInput)),
                tmdbSearchStatus, tmdbError),
            element('section', { className: 'settings-section' },
                element('div', { className: 'section-header' }, element('h3', { textContent: 'Images' }),
                    element('div', { className: 'controls' }, expand, button('Choose another area', chooseArea))), scope,
                element('div', { className: 'image-fields comparison-only' }, field('Columns', columns), field('Image order', imageOrder),
                    element('div', { className: 'field column-names' }, element('span', { className: 'field-label', textContent: 'Column names' }), names)),
                element('div', { className: 'selection-toolbar' }, element('span', { className: 'field-label', textContent: 'Select images' }), button('Select all', () => {
                state.selected = new Set(state.images.map((_, i) => i)); state.anchor = null; update();
            }), button('Clear', () => { state.selected.clear(); state.anchor = null; update(); }),
                hint('image-selection-help', 'Image selection help', 'Click to toggle · Shift-click to select a range · Image order follows the selected images on the page: row by row, or all of column 1, then column 2, etc.')), candidates));
        dialog.append(element('div', { className: 'dialog-header' }, element('h2', { textContent: 'Rehost images' }),
            element('button', { type: 'button', className: 'close', textContent: '×', ariaLabel: 'Close', title: 'Close', onclick: close })),
            settings, widthSection, summary, element('div', { className: 'preview' }, preview),
            element('div', { className: 'controls' }, uploadButton, downloadButton, cancelButton, resetButton), status, result, debugPanel,
            element('a', { className: 'comparison-only', href: `${SLOW}/comparison`, target: '_blank', rel: 'noopener noreferrer', textContent: 'Open slow.pics (login or access check)' }));
        shadow.append(style, picker, dialog);
        document.documentElement.append(host);

        function countColumns() { return Math.max(1, Math.min(state.images.length || 2, Math.floor(Number(columns.value)) || 2)); }
        function getNames() { return [...names.children].map((input, i) => input.value.trim() || `Column ${i + 1}`); }
        function selectedImages() {
            const items = state.images.filter((_, i) => state.selected.has(i));
            const n = countColumns();
            if (destination.value !== 'slowpics' || imageOrder.value !== 'columns' || items.length % n) return items;
            const rows = items.length / n;
            return items.map((_, i) => items[(i % n) * rows + Math.floor(i / n)]);
        }

        refreshOpenSettings = () => {
            const storedKey = GM_getValue('tmdb_api_key', '');
            tmdbAPIKey = typeof storedKey === 'string' ? storedKey.trim() : '';
            resetTMDBResults();
            tmdbSearchSection.hidden = !tmdbAPIKey;
            tmdbResultField.hidden = !tmdbAPIKey;
            tmdbSearchHint.hidden = !!tmdbAPIKey;
            update();
        };

        function cancelTMDBSearch() {
            tmdbSearchController?.abort();
            tmdbSearchController = null;
            tmdbSearchButton.disabled = !tmdbAPIKey;
        }

        function setTMDBResultsOpen(open) {
            tmdbResults.hidden = !open;
            tmdbResultsButton.setAttribute('aria-expanded', String(open));
        }

        function clearTMDBSelection() {
            for (const option of tmdbResults.children) option.setAttribute('aria-selected', 'false');
            tmdbResultsButton.textContent = tmdbResults.children.length ? 'Choose a result…' : 'Search for a title above';
        }

        function resetTMDBResults() {
            cancelTMDBSearch();
            setTMDBResultsOpen(false);
            tmdbResults.replaceChildren();
            clearTMDBSelection();
            tmdbResultsButton.disabled = true;
            tmdbSearchStatus.textContent = '';
        }

        async function findTMDB() {
            if (state.active || state.job || !tmdbAPIKey) return;
            resetTMDBResults();
            const controller = new AbortController();
            tmdbSearchController = controller;
            tmdbSearchButton.disabled = true;
            tmdbSearchStatus.textContent = 'Searching TMDB…';
            try {
                const type = tmdbType.value;
                const matches = await searchTMDB(type, tmdbQuery.value, tmdbAPIKey, controller.signal);
                if (tmdbSearchController !== controller || !host.isConnected) return;
                const countryLabels = [];
                tmdbResults.replaceChildren(...matches.map(item => {
                    const label = `${item.title} (${item.year}) · ID ${item.id}`;
                    const country = element('span', { className: 'tmdb-country', textContent: countryNames(item.countries) });
                    country.title = country.textContent;
                    countryLabels.push(country);
                    const poster = element('span', { className: 'tmdb-poster', textContent: 'No poster' });
                    if (item.poster) poster.replaceChildren(element('img', { src: item.poster, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer',
                        onerror: () => { poster.textContent = 'No poster'; } }));
                    const option = button('', () => {
                        if (state.active || state.job) return;
                        clearTMDBSelection();
                        option.setAttribute('aria-selected', 'true');
                        tmdbResultsButton.textContent = label;
                        tmdbInput.value = `${type.toLowerCase()}/${item.id}`;
                        setTMDBResultsOpen(false);
                        tmdbResultsButton.focus();
                        update();
                    });
                    Object.assign(option, { className: 'tmdb-option', role: 'option', tabIndex: -1, title: label });
                    option.setAttribute('aria-selected', 'false');
                    option.append(poster, element('span', { className: 'tmdb-description' }, element('span', { textContent: label }), country));
                    return option;
                }));
                clearTMDBSelection();
                tmdbResultsButton.disabled = !matches.length;
                tmdbSearchButton.disabled = false;
                tmdbSearchStatus.textContent = matches.length ? '' : 'No matches. Try another title.';
                // Movie search omits countries. Show matches immediately, then fill in their countries.
                if (type === 'MOVIE') {
                    for (let i = 0; i < matches.length; i++) {
                        if (matches[i].countries.length) continue;
                        try {
                            const codes = await movieCountries(matches[i].id, tmdbAPIKey, controller.signal);
                            if (tmdbSearchController !== controller || !host.isConnected) return;
                            countryLabels[i].textContent = countryNames(codes);
                            countryLabels[i].title = countryLabels[i].textContent;
                        } catch (error) {
                            if (error.name === 'AbortError') return;
                            if (error.stopTransfer || error.status === 401) break;
                        }
                    }
                }
            } catch (error) {
                if (tmdbSearchController === controller && host.isConnected && error.name !== 'AbortError') tmdbSearchStatus.textContent = error.message;
            } finally {
                if (tmdbSearchController === controller) cancelTMDBSearch();
            }
        }

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
            const standalone = destination.value !== 'slowpics';
            const items = selectedImages(), labels = getNames(), n = standalone ? 1 : countColumns();
            if (!state.customTitle && !state.job) title.value = collectionName(document.title, labels);
            const busy = !!state.active;
            let namingError = '', linkingError = '', keyError = '';
            if (!standalone) {
                try { fileColumns(labels); } catch (error) { namingError = error.message; }
                try { tmdbReference(tmdbInput.value); } catch (error) { linkingError = error.message; }
            } else {
                try { hostKey(destination.value); } catch (error) { keyError = error.message; }
            }
            dialog.querySelectorAll('.comparison-only').forEach(node => { node.hidden = standalone; });
            widthSection.hidden = !standalone;
            dialog.querySelector('#image-selection-help').textContent = 'Click to toggle · Shift-click to select a range · '
                + (standalone ? 'Images follow their order on the page.'
                    : 'Image order follows the selected images on the page: row by row, or all of column 1, then column 2, etc.');
            nsfwField.hidden = destination.value !== 'pixhost';
            keyHint.textContent = keyError;
            keyHint.hidden = !keyError;
            tmdbError.textContent = linkingError;
            tmdbError.hidden = !linkingError;
            tmdbInput.setCustomValidity(linkingError);
            const invalid = !items.length || items.length % n !== 0 || !!namingError;
            settings.disabled = busy || !!state.job;
            uploadButton.disabled = busy || invalid || !!linkingError || !!keyError || state.job?.done === items.length;
            downloadButton.disabled = busy || invalid;
            cancelButton.hidden = !busy;
            resetButton.hidden = !state.job || busy;
            uploadButton.textContent = state.job && state.job.done < state.job.items.length ? 'Retry upload'
                : `Upload to ${standalone ? imageHosts[destination.value].label : 'slow.pics'}`;
            expand.disabled = !state.root || state.root === document.body;
            [...candidates.children].forEach((node, i) => node.setAttribute('aria-pressed', String(state.selected.has(i))));
            summary.textContent = standalone ? `${items.length} image(s) selected.`
                : `${items.length} selected → ${Math.floor(items.length / n)} complete rows × ${n} columns`
                + (items.length % n ? `; ${items.length % n} image(s) in an incomplete row. Every column needs the same number of images.` : '.')
                + (namingError ? ` ${namingError}` : '');
            preview.style.gridTemplateColumns = standalone ? 'repeat(auto-fill, minmax(110px, 1fr))' : `repeat(${n}, minmax(110px, 1fr))`;
            preview.replaceChildren(...items.map((item, i) => element('figure', {}, thumbnail(item),
                element('figcaption', { textContent: standalone ? `Image ${i + 1}` : `${String(Math.floor(i / n) + 1).padStart(4, '0')} · ${labels[i % n]}` }))));
        }

        function showArea(area) {
            state.root = area?.root || null;
            state.images = area?.images || [];
            state.selected.clear();
            state.anchor = null;
            columns.value = String(area?.names.length || 2);
            updateNames(area?.names || []);
            scope.hidden = !!area;
            scope.textContent = area ? ''
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
            const standalone = destination.value !== 'slowpics';
            const items = selectedImages(), labels = standalone ? ['Image'] : getNames();
            let tmdbId = '';
            try {
                requireCompleteRows(items, labels);
                fileColumns(labels);
                if (kind === 'upload') {
                    if (standalone) hostKey(destination.value);
                    else if (!state.job) tmdbId = tmdbReference(tmdbInput.value);
                }
            }
            catch (error) { status.textContent = error.message; return; }
            if (tmdbSearchController) resetTMDBResults();
            setTMDBResultsOpen(false);
            const controller = new AbortController();
            state.active = controller;
            if (kind === 'upload' && !standalone) result.replaceChildren();
            const report = message => { status.textContent = message; };
            debug('transfer-start', { kind, images: items.length, columns: labels.length, completed: kind === 'upload' ? state.job?.done || 0 : 0 });
            try {
                if (kind === 'upload' && standalone) {
                    state.job ||= { destination: destination.value, items, nsfw: nsfw.checked, done: 0, pending: null, results: [] };
                    update();
                    await uploadImages(state.job, controller.signal, report, renderImageResults);
                    report(`Complete — ${state.job.done} images uploaded.`);
                } else if (kind === 'upload') {
                    state.job ||= { items, names: labels, title: title.value.trim() || 'Comparison', public: publicInput.checked, tmdbId,
                        browserId: browserID(), done: 0, collection: null, pending: null };
                    update();
                    const url = await upload(state.job, controller.signal, report);
                    report(`Complete — ${state.job.done} images uploaded.`);
                    const completedJob = state.job;
                    const comparisonOutput = element('textarea', { readOnly: true, hidden: true, ariaLabel: 'Comparison BBCode' });
                    const comparisonCopy = button('Copy BBCode', () => copyComparisonBBCode(completedJob, comparisonOutput, comparisonCopy));
                    result.append(element('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: url }),
                        button('Copy link', async () => {
                            try { await navigator.clipboard.writeText(url); report('Comparison link copied.'); }
                            catch { report('Clipboard access was denied. Select and copy the displayed link.'); }
                        }), comparisonCopy, comparisonOutput);
                } else {
                    update();
                    await download(items, labels, controller.signal, report);
                }
            } catch (error) {
                const progress = kind === 'upload' && state.job ? ` ${state.job.done}/${state.job.items.length} uploaded.` : '';
                report(`${error.name === 'AbortError' ? 'Cancelled.' : error.message}${progress}`
                    + (kind === 'upload' && standalone && state.job ? ' Completed results are kept. Retry resumes at the first unconfirmed image; a lost response may cause a duplicate.' : '')
                    + (kind === 'upload' && state.job?.collection ? ' The remote collection is incomplete. After resolving the error, retry upload to resume, or start over to change the selection.' : ''));
            } finally {
                state.active = null;
                if (host.isConnected) update();
            }
        }

        async function copyComparisonBBCode(job, output, copyButton) {
            if (state.active || state.job !== job) return;
            const controller = new AbortController();
            state.active = controller;
            copyButton.disabled = true;
            update();
            try {
                if (!job.bbcode) {
                    status.textContent = 'Loading uploaded image URLs for BBCode…';
                    const urls = await comparisonImageURLs(job, controller.signal);
                    job.bbcode = comparisonBBCode(job, urls);
                }
                checkAbort(controller.signal);
                output.value = job.bbcode;
                output.hidden = false;
                try {
                    await navigator.clipboard.writeText(job.bbcode);
                    status.textContent = 'Comparison BBCode copied.';
                } catch {
                    status.textContent = 'Clipboard access was denied. Select and copy the comparison BBCode below.';
                }
            } catch (error) {
                status.textContent = `Upload complete. ${error.name === 'AbortError' ? 'BBCode lookup cancelled.' : error.message}`
                    + ' The comparison link is still available. Click Copy BBCode to try again.';
            } finally {
                state.active = null;
                copyButton.disabled = false;
                if (host.isConnected) update();
            }
        }

        function close() {
            cancelTMDBSearch();
            refreshOpenSettings = null;
            tmdbAPIKey = '';
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
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopImmediatePropagation();
                if (!tmdbResults.hidden) { setTMDBResultsOpen(false); tmdbResultsButton.focus(); }
                else close();
            }
        }, { capture: true, signal: lifetime.signal });
        host.addEventListener('comps-rehost-focus', () => {
            if (dialog.open) dialog.focus();
            else picker.querySelector('button').focus();
        }, { signal: lifetime.signal });
        debug('ready', { scriptVersion: typeof GM_info === 'object' ? GM_info.script?.version : '1.2.1',
            manager: typeof GM_info === 'object' ? GM_info.scriptHandler : 'unknown',
            managerVersion: typeof GM_info === 'object' ? GM_info.version : 'unknown' });
        chooseArea();
    }
})();
