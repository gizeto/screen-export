const assert = require('node:assert/strict');
const { readFileSync, existsSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const source = readFileSync(join(__dirname, '..', 'comps-rehost.user.js'), 'utf8');
const chrome = process.env.CHROME_BIN || [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'
].find(existsSync);

test('metadata defers injection and requests no page-script or persistent-storage access', () => {
    assert.match(source, /@run-at\s+context-menu/);
    assert.match(source, /@sandbox\s+DOM/);
    assert.doesNotMatch(source, /@(?:require|resource|icon)\s|@grant\s+(?:unsafeWindow|GM_.*Value)/);
    assert.doesNotMatch(source, /MutationObserver|setInterval|GM_registerMenuCommand/);
});

// A real DOM and image decoder, without a browser automation dependency or the user's profile.
async function inChrome(expression) {
    const profile = mkdtempSync(join(tmpdir(), 'comps-rehost-test-'));
    const child = spawn(chrome, ['--headless', '--disable-gpu', '--disable-background-networking',
        '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
        `--user-data-dir=${profile}`, 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let socket;
    const pending = new Map();
    try {
        const endpoint = await new Promise((resolve, reject) => {
            let log = '';
            const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${log.slice(-1000)}`)), 20000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Chrome exited: ${code || signal}. Browser execution may need sandbox permission.`)); });
            child.stderr.on('data', chunk => {
                log += chunk;
                const url = log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
                if (url) { clearTimeout(timer); resolve(url); }
            });
        });
        socket = new WebSocket(endpoint);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        let id = 0;
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            const callback = pending.get(message.id);
            if (callback) { pending.delete(message.id); callback(message); }
        });
        const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
            const current = ++id;
            const timer = setTimeout(() => { pending.delete(current); reject(new Error(`CDP timed out: ${method}`)); }, 30000);
            pending.set(current, message => {
                clearTimeout(timer);
                if (message.error) reject(new Error(message.error.message));
                else resolve(message.result);
            });
            socket.send(JSON.stringify({ id: current, method, params, sessionId }));
        });
        const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
        await call('Page.enable', {}, sessionId);
        await call('Network.enable', {}, sessionId);
        await call('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] }, sessionId);
        const { frameTree } = await call('Page.getFrameTree', {}, sessionId);
        await call('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<!doctype html>
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:">
            <base href="https://fixture.test/details"><body></body>` }, sessionId);
        const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
    } finally {
        socket?.close();
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
        child.stderr.destroy();
        child.unref();
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

async function browserTests(script, examples, pixhostHTML) {
    const results = [];
    // Read the configured image host without duplicating its domain in fixtures.
    const imageHostDomain = script.match(/https:\/\/img\.([^/]+)\/getimg\//)[1];
    const equal = (actual, expected) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    };
    const ok = (value, message = 'Assertion failed') => { if (!value) throw new Error(message); };
    const rejects = async (action, match) => {
        try { await action(); } catch (error) { ok(match.test(error.message), error.message); return; }
        throw new Error('Expected rejection');
    };
    const test = async (name, action) => {
        try { await action(); results.push({ name, ok: true }); }
        catch (error) { results.push({ name, ok: false, error: error.stack }); }
    };
    const calls = [];
    let handler = () => { throw new Error('Unexpected request'); };
    globalThis.GM_xmlhttpRequest = options => {
        calls.push(options);
        let aborted = false;
        queueMicrotask(() => {
            if (aborted) return;
            try {
                const response = handler(options);
                if (response) options.onload({ status: 200, finalUrl: options.url, ...response });
            } catch (error) { options.onerror({ error: error.message }); }
        });
        return { abort() { aborted = true; options.onabort?.(); } };
    };
    globalThis.GM_download = () => { throw new Error('Unexpected download'); };
    globalThis.GM_cookie = { list() { throw new Error('Unexpected cookie access'); } };
    const exposed = script.replace('    chooseArea();\n})();', `
        globalThis.rehost = { httpURL, unwrapURL, originalURL, columnNames, imageInfo, inertHTML, detect, scan,
            selectRange, fetchOriginal, imageFile, request, upload, download, filename, slowToken, state,
            showArea, chooseArea, expandArea, close, dialog, picker, candidates, columns, names,
            uploadButton, downloadButton, summary, settings, preview, run, status, resetButton, result, browserID,
            diagnostics, retryAfter, slowRequest, fileColumns };
        chooseArea();
    })();`);
    await test('activation installs only the picker, without resolving images or accessing cookies', () => {
        ok(!document.getElementById('comps-rehost-dialog'));
        (0, eval)(exposed);
        equal(calls.length, 0);
        ok(!rehost.picker.hidden && !rehost.dialog.open);
    });
    const api = globalThis.rehost;
    if (!api) return results;
    const controller = () => new AbortController();
    const fixture = html => {
        const root = document.createElement('div');
        const fragment = api.inertHTML(html);
        fragment.querySelectorAll('script, style, link, base, iframe, object, embed').forEach(node => node.remove());
        fragment.querySelectorAll('*').forEach(node => {
            for (const attribute of [...node.attributes]) if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
        });
        root.append(fragment);
        return root;
    };
    const img = (id, attributes = '') => `<a href="https://images.test/${id}.png"><img src="https://images.test/${id}.png" ${attributes}></a>`;
    await test('heading parsing handles inline vs, punctuation and decoration, and rejects prose URLs/BBCode', () => {
        equal(api.columnNames('ProRes vs. Filtered Source vs. Encode vs. DON vs. EbP vs. leverage'), ['ProRes', 'Filtered Source', 'Encode', 'DON', 'EbP', 'leverage']);
        equal(api.columnNames('========== [FraMeSToR vs j3rico] =========='), ['FraMeSToR', 'j3rico']);
        equal(api.columnNames(' SOURCE vs ENCODE : '), ['SOURCE', 'ENCODE']);
        equal(api.columnNames('AUS vs FRA: https://slow.pics/c/example'), null);
        equal(api.columnNames('[color=red]SOURCE[/color] vs ENCODE'), null);
        equal(api.columnNames('SOURCE vs '), null);
    });
    await test('section detection splits repeated headings and preserves duplicate image occurrences', () => {
        const root = fixture(`<section><b>Source <span>vs.</span> Encode</b><br>${img('same')}${img('same')}<br>
            <b>Other vs Encode</b><br>${img('b')}${img('c')}</section>`);
        const images = root.querySelectorAll('img');
        const first = api.detect(images[0]), second = api.detect(images[3]);
        equal(first.names, ['Source', 'Encode']);
        equal(first.images.length, 2);
        equal(first.images.map(item => item.source), ['https://images.test/same.png', 'https://images.test/same.png']);
        equal(second.names, ['Other', 'Encode']);
        equal(second.images.length, 2);
    });
    await test('hidden images and lazy sources remain candidates; known small decorations are excluded', () => {
        const root = fixture(`<section>Source vs Encode<br><img width="16" height="16" src="https://images.test/icon.png">
            <div hidden>${img('a')}<img src="data:image/gif;base64,AAAA" data-src="https://images.test/b.png" width="1" height="1"></div></section>`);
        const area = api.detect(root.querySelector('section'));
        equal(area.images.length, 2);
        equal(area.images[1].source, 'https://images.test/b.png');
    });
    await test('srcset chooses its largest source without fetching it', () => {
        const root = fixture('<img src="https://images.test/small.png" srcset="https://images.test/medium.png 800w, https://images.test/large.png 1600w">');
        equal(api.imageInfo(root.firstElementChild).source, 'https://images.test/large.png');
        equal(calls.length, 0);
    });
    await test('nameless nested galleries select their shared wrapper without reading raw code headings', () => {
        const root = fixture(`<section><div><div>${img('a')}</div><div>${img('b')}</div></div><pre>Source vs Encode</pre></section>`);
        const area = api.detect(root.querySelector('img'));
        equal(area.images.length, 2);
        equal(area.names, []);
        ok(area.root === root.querySelector('section > div'));
    });
    // The ignored local files are supplementary coverage; committed cases above remain self-contained.
    for (const [name, html] of Object.entries(examples)) {
        await test(`supplied ${name}: comparison boundaries and names`, () => {
            const root = fixture(html);
            const images = [...root.querySelectorAll('img')];
            const find = part => images.find(image => image.getAttribute('src')?.includes(part));
            if (name === 'ex1') {
                const screens = images.filter(image => image.src.includes(`t.${imageHostDomain}`));
                equal(api.detect(screens[0]).images.length, 24);
                equal(api.detect(screens[24]).images.length, 60);
                equal(api.detect(screens[24]).names.length, 6);
            } else if (name === 'ex2') {
                const groups = [...root.querySelectorAll('.codemain')].filter(group => group.querySelector('img'));
                equal([...groups].map(group => api.detect(group.querySelector('img')).images.length), [3, 27]);
                equal(api.detect(groups[0].querySelector('img')).names, ['Source', 'Filtered', 'Encode']);
            } else if (name === 'ex9') {
                const area = api.detect(find('t3.pixhost.cc'));
                equal(area.images.length, 32);
                equal(area.names, []);
                equal(area.images[0].link, 'https://pixhost.cc/show/5385/764953339_1-source-040774.png');
                equal(area.images[0].source, 'https://t3.pixhost.cc/thumbs/5385/764953339_1-source-040774.png');
            } else if (name === 'ex3' || name === 'ex7') {
                const area = api.detect(name === 'ex3' ? find('Nightcrawler') : find('screenshots/'));
                equal(area.images.length, name === 'ex3' ? 14 : 16);
                equal(area.names, []);
            } else if (name === 'ex4') {
                const groups = root.querySelectorAll('.comparison');
                equal([...groups].map(group => api.detect(group.querySelector('button')).images.length), [30, 30, 30]);
                equal(api.detect(groups[0].querySelector('button')).names, ['AMZN TrollHD', 'DSNP playWEB']);
            } else if (name === 'ex5') {
                const area = api.detect(find('img4k.net'));
                equal(area.images.filter(item => item.link).length, 12);
                equal(area.names, []);
            } else if (name === 'ex6') {
                const area = api.detect(find('img4k.net'));
                equal(area.images.length, 12);
                equal(area.names, ['SOURCE', 'ENCODE']);
            } else if (name === 'ex8') {
                const area = api.detect(find('i.ibb.co'));
                equal(area.images.length, 16);
                equal(area.names, ['FraMeSToR', 'j3rico']);
            }
        });
    }
    await test('range selection works forward/backward, preserves other selections and toggles individually', () => {
        const selected = new Set();
        let anchor = api.selectRange(selected, 4, null, false);
        anchor = api.selectRange(selected, 1, anchor, true);
        equal([...selected].sort(), [1, 2, 3, 4]);
        equal(anchor, 4);
        api.selectRange(selected, 6, anchor, true);
        equal([...selected].sort(), [1, 2, 3, 4, 5, 6]);
        api.selectRange(selected, 3, anchor, false);
        ok(!selected.has(3));
    });
    await test('redirects and image-host transformations are bounded and protocol-safe', () => {
        equal(api.originalURL('https://site.test/link.php?sign=ignored&target=https%3A%2F%2Fi.ibb.co%2Foriginal%2Fimage.png'), 'https://i.ibb.co/original/image.png');
        equal(api.originalURL('https://site.test/redir.php?https://img4k.net/images/frame.md.png'), 'https://img4k.net/images/frame.png');
        equal(api.originalURL('https://proxy.example.test/?url=https%3A%2F%2Fi.slow.pics%2Fimage.webp'), 'https://i.slow.pics/image.webp');
        equal(api.originalURL(`https://t.${imageHostDomain}/Ab12.jpg`), `https://img.${imageHostDomain}/getimg/Ab12`);
        equal(api.originalURL(`https://img.${imageHostDomain}/Ab12`), `https://img.${imageHostDomain}/getimg/Ab12`);
        equal(api.originalURL(`https://${imageHostDomain}.evil.test/Ab12`), `https://${imageHostDomain}.evil.test/Ab12`);
        equal(api.httpURL('javascript:alert(1)'), '');
        equal(api.httpURL('https://user:password@example.test/image.png'), '');
        ok(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(api.browserID()));
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const imageResponse = () => ({ response: png });
    await test('Pixhost thumbnail-only images resolve across domains and server numbers without fetching thumbnails', async () => {
        for (const [domain, server] of [['pixhost.cc', '3'], ['pixhost.to', '97'], ['pixho.st', '12']]) {
            calls.length = 0;
            handler = imageResponse;
            const thumbnail = `https://t${server}.${domain}/thumbs/5385/frame.png`;
            const file = await api.fetchOriginal({ source: `https://site.test/redirect?url=${encodeURIComponent(thumbnail)}` }, controller().signal);
            equal(calls.map(call => call.url), [`https://img${server}.${domain}/images/5385/frame.png`]);
            equal(file.extension, 'png');
        }
        for (const url of ['https://t3.pixhost.cc.evil.test/thumbs/1/a.png', 'https://t3.other.test/thumbs/1/a.png',
            'https://t3.pixhost.cc/other/a.png', 'https://pixhost.cc/show/1/a.png']) equal(api.originalURL(url), url);
    });
    const pixhostPage = 'https://pixhost.cc/show/5385/764953339_1-source-040774.png';
    const pixhostThumbnail = 'https://t3.pixhost.cc/thumbs/5385/764953339_1-source-040774.png';
    const pixhostOriginal = 'https://img3.pixhost.cc/images/5385/764953339_1-source-040774.png';
    const pixhostFixture = `<meta property="og:image" content="${pixhostThumbnail}">
        <meta property="og:image:secure_url" content="${pixhostThumbnail}">
        <img id="image" src="${pixhostOriginal}" width="3840" height="1604">
        <script>window.pixhostScriptRan=true</script>`;
    for (const [name, html, original] of [
        ['displayed image takes precedence over thumbnail metadata', pixhostFixture.replace('img3.pixhost.cc', 'img4.pixhost.cc'), pixhostOriginal.replace('img3.', 'img4.')],
        ['thumbnail metadata resolves when the displayed image is absent', `<meta property="og:image" content="${pixhostThumbnail}">`, pixhostOriginal],
        ...(pixhostHTML ? [['supplied ex9_pixhost page', pixhostHTML, pixhostOriginal]] : [])
    ]) {
        await test(`Pixhost ${name}`, async () => {
            calls.length = 0;
            handler = options => {
                if (options.url === pixhostPage) return { response: new Blob([html], { type: 'text/html' }) };
                if (options.url === original) return imageResponse();
                throw new Error('Unexpected image URL');
            };
            const file = await api.fetchOriginal({ link: pixhostPage, source: pixhostThumbnail }, controller().signal);
            equal(calls.map(call => call.url), [pixhostPage, original]);
            equal(file.extension, 'png');
            equal([...new Uint8Array(await file.blob.arrayBuffer())], [...new Uint8Array(await png.arrayBuffer())]);
            ok(!globalThis.pixhostScriptRan);
        });
    }
    await test('Pixhost page failures fall back to the original URL but access blocks stop immediately', async () => {
        for (const status of [404, 403]) {
            calls.length = 0;
            handler = options => options.url === pixhostPage ? { status } : imageResponse();
            const action = () => api.fetchOriginal({ link: pixhostPage, source: pixhostThumbnail }, controller().signal);
            if (status === 403) {
                await rejects(action, /HTTP 403/);
                equal(calls.map(call => call.url), [pixhostPage]);
            } else {
                equal((await action()).extension, 'png');
                equal(calls.map(call => call.url), [pixhostPage, pixhostOriginal]);
            }
        }
    });
    await test('host metadata is inert and original image bytes and MIME type are preserved', async () => {
        calls.length = 0;
        handler = options => options.url.includes('/image/') ? { response: new Blob([
            '<meta property="og:image" content="https://img4k.net/images/full.png"><script>window.hostScriptRan=true</script><img src="https://tracking.test/pixel">'
        ], { type: 'text/html' }) } : { response: new Blob([png], { type: 'application/octet-stream' }) };
        const file = await api.fetchOriginal({ link: 'https://img4k.net/image/a', source: 'https://img4k.net/images/full.md.png' }, controller().signal);
        equal(calls.map(call => call.url), ['https://img4k.net/image/a', 'https://img4k.net/images/full.png']);
        equal(file.extension, 'png');
        equal(file.blob.type, 'image/png');
        equal([...new Uint8Array(await file.blob.arrayBuffer())], [...new Uint8Array(await png.arrayBuffer())]);
        ok(!globalThis.hostScriptRan);
    });
    await test('unresolved known thumbnails and misleading image MIME types are rejected', async () => {
        calls.length = 0;
        await rejects(() => api.fetchOriginal({ source: 'https://unknown.test/thumbs/a.png' }, controller().signal), /thumbnail/);
        equal(calls.length, 0);
        handler = () => ({ response: new Blob(['not an image'], { type: 'image/png' }) });
        await rejects(() => api.fetchOriginal({ source: 'https://images.test/a.png' }, controller().signal), /not a supported image/);
        await rejects(() => api.imageFile(new Blob([new Uint8Array([137, 80, 78, 71, 13, 10])]), controller().signal), /damaged/);
        handler = () => ({ finalUrl: 'https://images.test/thumbs/a.png', response: png });
        await rejects(() => api.fetchOriginal({ source: 'https://images.test/original.png' }, controller().signal), /redirected to a thumbnail/);
    });
    await test('HTTP failures are actionable and cancellation aborts the pending request', async () => {
        handler = () => ({ status: 403 });
        await rejects(() => api.request('https://images.test/a.png', {}, controller().signal), /HTTP 403/);
        handler = () => null;
        const active = controller();
        const pending = api.request('https://images.test/a.png', {}, active.signal);
        active.abort();
        await rejects(() => pending, /Cancelled/);
    });
    await test('missing CSRF tokens fail before any comparison is created and cookie reads are limited to slow.pics', async () => {
        handler = () => ({ responseText: '<html>Login required</html>' });
        const reads = [];
        GM_cookie.list = (query, callback) => { reads.push(query); callback([], null); };
        await rejects(() => api.slowToken(controller().signal), /No slow.pics session token/);
        equal(reads, [{ url: 'https://slow.pics/', name: 'XSRF-TOKEN', partitionKey: { topLevelSite: 'https://slow.pics' } },
            { url: 'https://slow.pics/', name: 'XSRF-TOKEN' }]);
    });
    await test('logged-in CSRF cookies skip the landing-page GET and select the matching cookie partition', async () => {
        calls.length = 0;
        const previous = GM_cookie.list;
        try {
            GM_cookie.list = (query, callback) => callback(query.partitionKey ? [{ name: 'XSRF-TOKEN', value: 'TOP_SECRET_CSRF%20VALUE' }] : [], null);
            handler = () => ({ status: 403, responseHeaders: 'Content-Type: text/html\nSet-Cookie: SESSION=AUTH_SESSION_SECRET;',
                responseText: 'Invalid CSRF token RAW_ERROR_BODY_SECRET' });
            const job = { items: [{ source: 'https://images.test/private-a.png' }, { source: 'https://images.test/private-b.png' }],
                names: ['Source', 'Encode'], title: 'PRIVATE_COLLECTION', public: true, browserId: 'PRIVATE_BROWSER_ID', done: 0 };
            await rejects(() => api.upload(job, controller().signal, () => {}), /POST https:\/\/slow.pics\/upload\/comparison: HTTP 403.*CSRF/);
            equal(calls.length, 1);
            equal(calls[0].url, 'https://slow.pics/upload/comparison');
            equal(calls[0].anonymous, false);
            equal(calls[0].cookiePartition, { topLevelSite: 'https://slow.pics' });
            equal(calls[0].headers.Origin, 'https://slow.pics');
            equal(calls[0].headers.Referer, 'https://slow.pics/comparison');
            equal(calls[0].headers['X-XSRF-TOKEN'], 'TOP_SECRET_CSRF VALUE');
            ok(!calls[0].headers.Cookie && !calls[0].headers['User-Agent']);
            equal(job.done, 0);
            const logs = api.diagnostics.join('\n');
            ok(logs.includes('"category":"csrf"'));
            for (const secret of ['TOP_SECRET', 'AUTH_SESSION_SECRET', 'RAW_ERROR_BODY_SECRET', 'PRIVATE_COLLECTION', 'PRIVATE_BROWSER_ID']) ok(!logs.includes(secret));
        } finally { GM_cookie.list = previous; }
    });
    await test('unpartitioned login tokens also avoid GET; page metadata uses the CSRF header for raw tokens', async () => {
        calls.length = 0;
        const previous = GM_cookie.list;
        try {
            GM_cookie.list = (query, callback) => callback(query.partitionKey ? [] : [{ name: 'XSRF-TOKEN', value: 'cookie-token' }], null);
            equal(await api.slowToken(controller().signal), { value: 'cookie-token', header: 'X-XSRF-TOKEN' });
            equal(calls.length, 0);
            GM_cookie.list = (_, callback) => callback([], null);
            handler = () => ({ responseText: '<meta name="csrf-token" content="RAW_CSRF_SECRET"><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>' });
            equal(await api.slowToken(controller().signal), { value: 'RAW_CSRF_SECRET', header: 'X-CSRF-TOKEN' });
            equal(calls.length, 1);
            equal(calls[0].cookiePartition, { topLevelSite: 'https://slow.pics' });
            ok(!api.diagnostics.join('\n').includes('RAW_CSRF_SECRET'));
        } finally { GM_cookie.list = previous; }
    });
    await test('ordinary image requests receive no slow.pics headers or cookie settings and redact URLs', async () => {
        calls.length = 0;
        handler = imageResponse;
        await api.request('https://images.test/PRIVATE_FILENAME.png?passkey=PRIVATE_QUERY', {}, controller().signal);
        equal(calls.length, 1);
        ok(!calls[0].headers && !calls[0].cookiePartition && !calls[0].cookie);
        ok(!/PRIVATE_FILENAME|PRIVATE_QUERY/.test(api.diagnostics.join('\n')));
    });
    await test('403 challenges stop downloads after one request without probing fallback URLs or later images', async () => {
        calls.length = 0;
        handler = () => ({ status: 403, responseHeaders: 'Content-Type: text/html; charset=utf-8\nServer: cloudflare\ncf-mitigated: challenge',
            responseText: '<html><title>Just a moment...</title>PRIVATE_ERROR_BODY</html>' });
        const messages = [];
        await api.download([{ link: 'https://blocked.test/page', source: 'https://blocked.test/thumb.png' }, { source: 'https://blocked.test/b.png' }],
            ['Source', 'Encode'], controller().signal, message => messages.push(message));
        equal(calls.length, 1);
        ok(messages.at(-1).includes('Stopped — 0 saved, 1 failed, 1 not completed.'));
        ok(messages.at(-1).includes('access challenge'));
        ok(api.diagnostics.join('\n').includes('"category":"challenge"'));
        ok(!api.diagnostics.join('\n').includes('PRIVATE_ERROR_BODY'));
    });
    await test('429 Retry-After prevents an early manual retry without sending another request', async () => {
        calls.length = 0;
        handler = () => ({ status: 429, responseHeaders: 'Retry-After: 120' });
        await rejects(() => api.request('https://limited.test/image.png', {}, controller().signal), /HTTP 429/);
        await rejects(() => api.request('https://limited.test/other.png', {}, controller().signal), /wait \d+s/);
        equal(calls.length, 1);
    });
    await test('column-first filenames have a shared four-digit comparison suffix and no collection prefix', () => {
        const prefixes = api.fileColumns(['first', 'second', 'third']);
        equal(Array.from({ length: 6 }, (_, i) => api.filename(i, prefixes, 'png')),
            ['first0001.png', 'second0001.png', 'third0001.png', 'first0002.png', 'second0002.png', 'third0002.png']);
        equal(api.filename(0, api.fileColumns(['x265', 'Encode']), 'webp'), 'x265_0001.webp');
        equal(api.filename(19998, ['Source', 'Encode'], 'jpg'), 'Source10000.jpg');
    });
    await test('incomplete selections and sanitized name collisions are rejected before any requests', async () => {
        calls.length = 0;
        await rejects(() => api.download([{ source: 'https://images.test/a.png' }], ['Source', 'Encode'], controller().signal, () => {}), /same number/);
        await rejects(() => api.download([{ source: 'https://images.test/a.png' }, { source: 'https://images.test/b.png' }], ['A/B', 'A:B'], controller().signal, () => {}), /identical filenames/);
        await rejects(() => Promise.resolve(api.fileColumns(['Source', 'source'])), /identical filenames/);
        await rejects(() => Promise.resolve(api.fileColumns(['x265', 'x265_'])), /identical filenames/);
        equal(calls.length, 0);
    });
    await test('partial uploads resume the same collection and slot with correct multipart names and file types', async () => {
        calls.length = 0;
        let fail = true;
        handler = options => {
            if (options.url.endsWith('/comparison') && options.method === 'GET') return { responseHeaders: 'Set-Cookie: XSRF-TOKEN=test%20token; Path=/', responseText: '' };
            if (options.url.endsWith('/upload/comparison')) return { responseText: JSON.stringify({ collectionUuid: 'collection', key: 'key', images: [['slot-a', 'slot-b']] }) };
            if (options.url.endsWith('/upload/image')) {
                if (options.data.get('imageUuid') === 'slot-b' && fail) { fail = false; return { status: 503 }; }
                return { responseText: 'OK' };
            }
            return imageResponse();
        };
        const job = { items: [{ source: 'https://images.test/a.png' }, { source: 'https://images.test/b.png' }],
            names: ['Source', 'Encode'], title: 'A < B', public: true, browserId: 'browser-id', done: 0 };
        await rejects(() => api.upload(job, controller().signal, () => {}), /HTTP 503/);
        equal(job.done, 1);
        ok(job.pending);
        equal(await api.upload(job, controller().signal, () => {}), 'https://slow.pics/c/key');
        equal(job.done, 2);
        equal(job.pending, null);
        const creates = calls.filter(call => call.url.endsWith('/upload/comparison'));
        equal(creates.length, 1);
        equal(creates[0].data.get('public'), 'true');
        equal(creates[0].data.get('optimize-images'), 'false');
        equal(creates[0].data.get('comparisons[0].imageNames[1]'), 'Encode');
        equal(creates[0].data.get('comparisons[0].name'), '0001');
        equal(calls.filter(call => call.url === 'https://images.test/b.png').length, 1);
        const uploads = calls.filter(call => call.url.endsWith('/upload/image'));
        equal(uploads.map(call => call.data.get('imageUuid')), ['slot-a', 'slot-b', 'slot-b']);
        equal(uploads[0].data.get('file').type, 'image/png');
        equal(uploads[0].data.get('file').name, 'Source0001.png');
        equal(uploads[1].data.get('file').name, 'Encode0001.png');
        equal(uploads[0].headers['X-XSRF-TOKEN'], 'test token');
        ok(uploads.every(call => call.cookiePartition.topLevelSite === 'https://slow.pics' && call.anonymous === false));
    });
    await test('malformed comparison responses and unsuccessful image acknowledgements never report success', async () => {
        handler = options => options.method === 'GET' ? { responseText: '<meta name="csrf-token" content="token">' }
            : { responseText: JSON.stringify({ collectionUuid: 'c', key: 'k', images: [['only-one']] }) };
        const job = { items: [{ source: 'https://images.test/a.png' }, { source: 'https://images.test/b.png' }], names: ['A', 'B'], title: 'Test', public: true, browserId: 'id', done: 0 };
        await rejects(() => api.upload(job, controller().signal, () => {}), /Unexpected slow.pics/);
        equal(job.done, 0);
        job.collection = { collectionUuid: 'c', key: 'k', images: [['a', 'b']] };
        handler = options => options.url.endsWith('/comparison') ? { responseHeaders: 'Set-Cookie: XSRF-TOKEN=token;' }
            : options.method === 'POST' ? { responseText: 'FAILED' } : imageResponse();
        await rejects(() => api.upload(job, controller().signal, () => {}), /did not accept image/);
        equal(job.done, 0);
    });
    await test('downloads use verified blobs, safe filenames and accurate success/failure counts', async () => {
        handler = imageResponse;
        const saved = [], messages = [];
        GM_download = options => {
            saved.push(options);
            queueMicrotask(() => saved.length === 2 ? options.onerror({ error: 'not_whitelisted' }) : options.onload());
            return { abort() {} };
        };
        await api.download([{ source: 'https://images.test/a.png' }, { source: 'https://images.test/b.png' }],
            ['Source', 'En:code'], controller().signal, message => messages.push(message));
        equal(saved.map(item => item.name), ['Source0001.png', 'En_code0001.png']);
        ok(saved.every(item => item.url instanceof Blob));
        equal(saved[0].conflictAction, 'prompt');
        ok(messages.at(-1).startsWith('1 saved, 1 failed.'));
        ok(messages.at(-1).includes('not_whitelisted'));
    });
    await test('download cancellation stops subsequent files and reports already saved files', async () => {
        handler = imageResponse;
        const active = controller(), messages = [];
        let saved = 0;
        GM_download = options => {
            queueMicrotask(() => { saved++; options.onload(); active.abort(); });
            return { abort() {} };
        };
        await api.download([{ source: 'https://images.test/a.png' }, { source: 'https://images.test/b.png' }],
            ['A', 'B'], active.signal, message => messages.push(message));
        equal(saved, 1);
        ok(messages.at(-1).startsWith('Cancelled — 1 saved, 0 failed, 1 not completed.'));
    });
    await test('picker suppresses site clicks, selection updates the grid and incomplete rows block both outputs', async () => {
        const root = fixture(`<div><b>Source vs Encode</b><br>${img('a')}${img('b')}${img('c')}${img('d')}</div>`);
        document.body.append(root);
        let pageClicks = 0;
        root.addEventListener('click', event => { pageClicks++; event.preventDefault(); });
        root.querySelector('img').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        equal(pageClicks, 0);
        equal(api.state.images.length, 4);
        equal(api.state.selected.size, 0);
        ok(api.dialog.open && api.picker.hidden);
        api.candidates.children[0].click();
        api.candidates.children[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        equal(api.state.selected.size, 4);
        ok(!api.uploadButton.disabled);
        equal(api.preview.children.length, 4);
        api.columns.value = '3';
        api.columns.dispatchEvent(new Event('change'));
        ok(api.uploadButton.disabled);
        ok(api.downloadButton.disabled);
        ok(api.summary.textContent.includes('incomplete'));
        equal(api.names.children.length, 3);
        // A failed upload must lock its mapping until resumed or explicitly reset.
        api.columns.value = '2';
        api.columns.dispatchEvent(new Event('change'));
        handler = options => options.url.endsWith('/comparison') && options.method === 'GET'
            ? { responseHeaders: 'Set-Cookie: XSRF-TOKEN=token;' }
            : options.url.endsWith('/upload/comparison')
                ? { responseText: JSON.stringify({ collectionUuid: 'c', key: 'k', images: [['a', 'b'], ['c', 'd']] }) }
                : options.method === 'POST' ? { status: 503 } : imageResponse();
        await api.run('upload');
        ok(api.settings.disabled);
        equal(api.uploadButton.textContent, 'Retry upload');
        ok(api.state.job.collection);
        ok(api.status.textContent.includes('incomplete'));
        api.resetButton.click();
        equal(api.state.job, null);
        ok(!api.settings.disabled);
        (0, eval)(exposed);
        equal(document.querySelectorAll('#comps-rehost-dialog').length, 1);
        api.close();
        root.querySelector('img').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        equal(pageClicks, 1);
        root.remove();
        ok(!document.getElementById('comps-rehost-dialog'));
    });
    await test('Escape removes the picker and its temporary click listeners', () => {
        (0, eval)(exposed);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
        ok(!document.getElementById('comps-rehost-dialog'));
        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        document.body.dispatchEvent(click);
        ok(!click.defaultPrevented);
    });
    return results;
}

test('comparison behavior in isolated Chrome', { skip: !chrome && 'Set CHROME_BIN to run real-browser regression tests', timeout: 60000 }, async t => {
    const examples = {};
    for (let i = 1; i <= 9; i++) {
        const path = join(__dirname, '..', 'tmp', 'comp-examples', `ex${i}.html`);
        if (existsSync(path)) examples[`ex${i}`] = readFileSync(path, 'utf8');
    }
    const pixhostPath = join(__dirname, '..', 'tmp', 'comp-examples', 'ex9_pixhost.html');
    const pixhostHTML = existsSync(pixhostPath) ? readFileSync(pixhostPath, 'utf8') : '';
    const results = await inChrome(`(${browserTests.toString()})(${JSON.stringify(source)}, ${JSON.stringify(examples)}, ${JSON.stringify(pixhostHTML)})`);
    for (const result of results) {
        await t.test(result.name, () => assert.equal(result.ok, true, result.error));
    }
});
