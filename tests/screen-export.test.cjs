const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { test } = require('node:test');
const { crc32 } = require('node:zlib');

// Read the ZIP directory independently and validate each stored member with Node's CRC32.
async function readZIP(blob) {
    assert.equal(blob.type, 'application/zip');
    const bytes = Buffer.from(await blob.arrayBuffer());
    const end = bytes.length - 22;
    assert.equal(bytes.readUInt32LE(end), 0x06054b50);
    assert.equal(bytes.readUInt32LE(end + 4), 0);
    assert.equal(bytes.readUInt16LE(end + 20), 0);
    const count = bytes.readUInt16LE(end + 10);
    assert.equal(bytes.readUInt16LE(end + 8), count);
    let cursor = bytes.readUInt32LE(end + 16), localEnd = 0;
    assert.equal(cursor + bytes.readUInt32LE(end + 12), end);
    const files = [];
    for (let i = 0; i < count; i++) {
        assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
        assert.equal(bytes.readUInt16LE(cursor + 8), 0x0800);
        assert.equal(bytes.readUInt16LE(cursor + 10), 0); // STORE
        const size = bytes.readUInt32LE(cursor + 24);
        assert.equal(bytes.readUInt32LE(cursor + 20), size);
        const nameLength = bytes.readUInt16LE(cursor + 28);
        const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
        const local = bytes.readUInt32LE(cursor + 42);
        assert.equal(local, localEnd);
        assert.equal(bytes.readUInt32LE(local), 0x04034b50);
        assert.deepEqual(bytes.subarray(local + 4, local + 30), bytes.subarray(cursor + 6, cursor + 32));
        assert.equal(bytes.subarray(local + 30, local + 30 + nameLength).toString('utf8'), name);
        const start = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
        const data = bytes.subarray(start, start + size);
        assert.equal(crc32(data), bytes.readUInt32LE(cursor + 16));
        files.push({ name, bytes: [...data] });
        localEnd = start + size;
        cursor += 46 + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    }
    assert.equal(localEnd, bytes.readUInt32LE(end + 16));
    assert.equal(cursor, end);
    return files;
}

const source = readFileSync(join(__dirname, '..', 'screen-export.user.js'), 'utf8');
test('metadata enables menu registration and limits storage access to userscript settings', () => {
    assert.match(source, /@match\s+https:\/\/\*\/\*/);
    assert.doesNotMatch(source, /@match\s+http:\/\//);
    assert.match(source, /@run-at\s+document-end/);
    assert.match(source, /@sandbox\s+DOM/);
    assert.doesNotMatch(source, /@(?:require|resource)\s|@grant\s+unsafeWindow/);
    assert.match(source, /@grant\s+GM_getValue/);
    assert.match(source, /@grant\s+GM_setValue/);
    assert.match(source, /@grant\s+GM_registerMenuCommand/);
    assert.doesNotMatch(source, /MutationObserver|setInterval/);
});

// DOM behavior runs entirely in Node; jsdom does not load external resources.
async function inDOM(expression) {
    const dom = new JSDOM('<!doctype html><body></body>', {
        url: 'https://fixture.test/details', runScripts: 'outside-only', virtualConsole: new VirtualConsole()
    });
    Object.assign(dom.window, { Blob, FormData, TextEncoder, readZIP });
    // jsdom has no native dialog implementation or image decoder.
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    try {
        return await dom.window.eval(expression);
    } finally {
        dom.window.close();
    }
}

async function domTests(script, examples, pixhostHTML) {
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
    const savedSettings = new Map();
    const settingReads = [];
    globalThis.GM_getValue = (key, fallback) => { settingReads.push(key); return savedSettings.get(key) ?? fallback; };
    globalThis.GM_setValue = (key, value) => savedSettings.set(key, value);
    const menus = new Map();
    let nextMenuId = 1, promptValue = null;
    const prompts = [], alerts = [];
    globalThis.GM_registerMenuCommand = (label, callback, options = {}) => {
        const id = options.id ?? nextMenuId++;
        menus.set(id, { label, callback });
        return id;
    };
    globalThis.prompt = (message, value) => { prompts.push({ message, value }); return promptValue; };
    globalThis.alert = message => alerts.push(message);
    const keyMenu = () => [...menus.values()].find(menu => menu.label.startsWith('TMDB API key:'));
    const configureKey = value => { promptValue = value; keyMenu().callback(); };
    const launchFromMenu = () => [...menus.values()].find(menu => menu.label === 'Select comparison images').callback();
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
    const exposed = script.replace('        chooseArea();\n    }\n})();', `
        globalThis.screenExport = { httpURL, unwrapURL, originalURL, columnNames, imageInfo, inertHTML, detect, scan,
            selectRange, fetchOriginal, imageFile, request, upload, download, zipArchive, filename, slowToken, state,
            showArea, chooseArea, expandArea, close, dialog, picker, candidates, columns, names,
            uploadButton, downloadButton, summary, settings, preview, run, status, resetButton, result, browserID,
            diagnostics, retryAfter, slowRequest, fileColumns, collectionName, title, publicInput,
            tmdbReference, comparisonFields, tmdbType, tmdbInput, tmdbError, searchTMDB, findTMDB,
            tmdbQuery, tmdbSearchSection, tmdbSearchHint, imageOrder, selectedImages, suggestedMediaType,
            tmdbResults, tmdbResultsButton, tmdbSearchButton, tmdbSearchStatus,
            destination, nsfw, width, widthError, bbcode, copyBBCode, renderImageResults, imageBBCode,
            imageUploadResult, uploadImage, uploadImages, hostKey, update, comparisonBBCode, comparisonPageURLs, comparisonImageURLs, copyComparisonBBCode };
        chooseArea();
    }
    })();`);
    await test('startup registers Tampermonkey menus without creating UI or sending requests', () => {
        const before = document.documentElement.innerHTML;
        (0, eval)(exposed);
        equal(document.documentElement.innerHTML, before);
        equal(calls.length, 0);
        equal([...menus.values()].map(menu => menu.label), ['Select comparison images', 'TMDB API key: not set', 'PTScreens API key: not set', 'ImgBB API key: not set']);
        equal([...savedSettings], []);
    });
    await test('TMDB menu configures the key before launching and updates its status without duplicates', () => {
        configureKey(' BEFORE_LAUNCH_KEY ');
        equal(savedSettings.get('tmdb_api_key'), 'BEFORE_LAUNCH_KEY');
        equal(keyMenu().label, 'TMDB API key: configured');
        configureKey(null);
        equal(savedSettings.get('tmdb_api_key'), 'BEFORE_LAUNCH_KEY');
        equal(prompts.at(-1).value, '');
        ok(!JSON.stringify(prompts).includes('BEFORE_LAUNCH_KEY'));
        configureKey('');
        equal(keyMenu().label, 'TMDB API key: not set');
        equal(menus.size, 4);
        ok(!document.getElementById('screen-export-dialog'));
        equal(calls.length, 0);
    });
    await test('launch menu installs only the picker, without resolving images or accessing cookies', () => {
        launchFromMenu();
        equal(calls.length, 0);
        ok(!screenExport.picker.hidden && !screenExport.dialog.open);
        ok(!screenExport.dialog.querySelector('input[type="password"]'));
        ok(![...screenExport.picker.querySelectorAll('button'), ...screenExport.dialog.querySelectorAll('button')]
            .some(button => button.textContent === 'Settings'));
    });
    const api = globalThis.screenExport;
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
    await test('collection titles keep movie/year/season/resolution and omit alternate titles and release details', () => {
        const cases = [
            ['Hot Dog 2018 1080p BluRay DTS x264-GroupName :: SITE', 'Hot Dog 2018 1080p'],
            ['Stuck 2017 1080p AMZN WEB-DL DD+ 2.0 H.264-GroupName - site.cc', 'Stuck 2017 1080p'],
            ['Notting.Hill.1999.1080p.WEBRip.DD+7.1.x264-GroupName :: Site', 'Notting Hill 1999 1080p'],
            ['The Three Deaths of Marisela Escobedo AKA Las tres muertes de Marisela Escobedo 2020 SPANISH 2160p NF WEB-DL DD+ 5.1 H.265-GroupName - Torrents - Site',
                'The Three Deaths of Marisela Escobedo 2020 2160p'],
            ['Age Inappropriate 2026 S01 1080p AMZN WEB-DL DD+ 2.0 H.264-GroupName - Torrents - Site', 'Age Inappropriate 2026 S01 1080p'],
            ['Example.Show.S02E03.720p.WEB-DL-GroupName :: Site', 'Example Show S02 720p'],
            ['2001 A Space Odyssey 1968 1080p BluRay-GroupName', '2001 A Space Odyssey 1968 1080p'],
            ['Example Film (2020) 2160p WEB-DL-GroupName', 'Example Film 2020 2160p'],
            ['', 'Comparison'], ['Site :: Browse torrents', 'Comparison'], ['1080p releases', 'Comparison']
        ];
        for (const [input, expected] of cases) {
            equal(api.collectionName(input, ['GroupA', 'GroupB']), `${expected} - GroupA vs GroupB`);
        }
        equal(api.collectionName(cases[0][0], ['Source', 'Filtered Source', 'Encode']),
            'Hot Dog 2018 1080p - Source vs Filtered Source vs Encode');
    });
    await test('pipe headings handle inline markup, multiword columns and section boundaries like ex10', () => {
        equal(api.columnNames('Source|Encode'), ['Source', 'Encode']);
        equal(api.columnNames('Source | '), null);
        equal(api.columnNames('Source || Encode'), null);
        equal(api.columnNames('Source | https://images.test/a.png'), null);
        const root = fixture(`<div align="center"><strong>Source <span>|</span> Encode</strong>
            ${Array.from({ length: 28 }, (_, i) => img(`pipe-${i}`)).join(' ')}
            <br><strong>Old GroupA | GroupB | GroupC</strong>${img('x')}${img('y')}${img('z')}</div>`);
        const images = [...root.querySelectorAll('img')];
        for (const image of images.slice(0, 28)) {
            const area = api.detect(image);
            equal(area.names, ['Source', 'Encode']);
            equal(area.images.length, 28);
        }
        const second = api.detect(images[28]);
        equal(second.names, ['Old GroupA', 'GroupB', 'GroupC']);
        equal(second.images.length, 3);
    });
    await test('heading parsing handles inline vs, punctuation and decoration, and rejects prose URLs/BBCode', () => {
        equal(api.columnNames('ProRes vs. Filtered Source vs. Encode vs. GroupA vs. GroupB vs. GroupC'), ['ProRes', 'Filtered Source', 'Encode', 'GroupA', 'GroupB', 'GroupC']);
        equal(api.columnNames('========== [GroupA vs GroupB] =========='), ['GroupA', 'GroupB']);
        equal(api.columnNames(' SOURCE vs ENCODE : '), ['SOURCE', 'ENCODE']);
        equal(api.columnNames('AUS vs FRA: https://slow.pics/c/example'), null);
        equal(api.columnNames('[color=red]SOURCE[/color] vs ENCODE'), null);
        equal(api.columnNames('SOURCE vs '), null);
    });
    await test('spaced headings preserve multiword names and distinguish visible gaps from source whitespace', () => {
        equal(api.columnNames('SOURCE \u00a0 \u00a0 SOURCE(FEL) \u00a0 \u00a0 GroupA \u00a0 \u00a0 OLD GroupA'),
            ['SOURCE', 'SOURCE(FEL)', 'GroupA', 'OLD GroupA']);
        equal(api.columnNames('Filtered\u00a0Source\u00a0\u00a0Encode'), ['Filtered Source', 'Encode']);
        equal(api.columnNames('  Source\n    Encode  '), null);
        equal(api.columnNames('SOURCE    SOURCE(FEL)    GroupA'), null);
        equal(api.columnNames('MORE SCREENSHOTS'), null);
        equal(api.columnNames('Source\u00a0Encode'), null);
        equal(api.columnNames('Source \u00a0 \u00a0 vs \u00a0 \u00a0 Encode'), ['Source', 'Encode']);
        equal(api.columnNames('Source\u00a0\u00a0https://images.test/a.png'), null);
        equal(api.columnNames('[color=red]SOURCE[/color]\u00a0\u00a0ENCODE'), null);
    });
    await test('spaced hyphens separate names without splitting hyphenated names', () => {
        equal(api.columnNames('SOURCE \u00a0 - \u00a0 ENCODE \u00a0 - \u00a0 GroupA \u00a0 - \u00a0 GroupB'),
            ['SOURCE', 'ENCODE', 'GroupA', 'GroupB']);
        equal(api.columnNames('WEB-DL - Old GroupA - GroupB-Encode'), ['WEB-DL', 'Old GroupA', 'GroupB-Encode']);
        equal(api.columnNames('WEB-DL'), null);
        equal(api.columnNames('Source - '), null);
        equal(api.columnNames('Source - - Encode'), null);
        equal(api.columnNames('[color=red]Source[/color] - Encode'), null);
        equal(api.columnNames('Source - https://images.test/a.png'), null);
    });
    await test('commas separate column names and reject empty columns', () => {
        equal(api.columnNames('Source, GroupA, GroupB'), ['Source', 'GroupA', 'GroupB']);
        equal(api.columnNames('Source,Old GroupA,WEB-DL'), ['Source', 'Old GroupA', 'WEB-DL']);
        equal(api.columnNames('Source, '), null);
        equal(api.columnNames('Source,,Encode'), null);
        equal(api.columnNames('Source, https://images.test/a.png'), null);
        equal(api.columnNames('[color=red]Source[/color], Encode'), null);
    });
    await test('hyphen headings detect columns and comparison boundaries across wrappers like ex11', () => {
        for (const tag of ['pre', 'div', 'section']) {
            const root = fixture(`<${tag}><div align="center">SOURCE &nbsp; - &nbsp; ENCODE &nbsp; - &nbsp; <span>GroupA</span> &nbsp; - &nbsp; GroupB</div></${tag}><br>
                <div align="center">${Array.from({ length: 24 }, (_, i) => img(`hyphen-${i}`)).join(' ')}</div>
                <${tag}>\nFiltered Source - GroupC-Encode\n</${tag}><div>${img('next-a')}${img('next-b')}</div>`);
            const images = [...root.querySelectorAll('img')];
            equal(api.scan(root, images[0]).headings.map(heading => heading.names),
                [['SOURCE', 'ENCODE', 'GroupA', 'GroupB'], ['Filtered Source', 'GroupC-Encode']]);
            for (const target of [root, ...images.slice(0, 24)]) {
                const area = api.detect(target);
                equal(area.names, ['SOURCE', 'ENCODE', 'GroupA', 'GroupB']);
                equal(area.images.map(item => item.source), images.slice(0, 24).map(image => image.src));
            }
            equal(api.detect(images[24]).names, ['Filtered Source', 'GroupC-Encode']);
            equal(api.detect(images[24]).images.length, 2);
        }
        equal(calls.length, 0);
    });
    await test('spaced slash headings detect comparison columns across wrappers like ex13', () => {
        equal(api.columnNames('Source / GroupA'), ['Source', 'GroupA']);
        equal(api.columnNames('Filtered Source / WEB-DL / Old GroupA'), ['Filtered Source', 'WEB-DL', 'Old GroupA']);
        for (const text of ['Source/Filtered', 'Source / ', 'Source / / Encode', 'Source / https://images.test/a.png']) {
            equal(api.columnNames(text), null);
        }
        const root = fixture(`<div align="center"><p><b>Release wrote:</b></p>
            <table><tbody><tr><td><pre><strong>Example Film 2012 1080p BluRay-GroupName</strong>
                CONTAINER: Matroska
                SUBTITLES: Eng, Pol, Spa
                RELEASE DATE: 29/06/2017</pre></td></tr></tbody></table></div>
            <div align="center"><strong>Source / GroupA</strong></div><br>
            <div align="center">${Array.from({ length: 16 }, (_, i) => img(`slash-${i}`)).join(' ')}</div>
            <p>More screenshots</p><div>${img('unrelated-a')}${img('unrelated-b')}</div>`);
        const images = [...root.querySelectorAll('img')];
        for (const target of images.slice(0, 16)) {
            const area = api.detect(target);
            equal(area.names, ['Source', 'GroupA']);
            equal(area.images.map(item => item.source), images.slice(0, 16).map(image => image.src));
        }
        equal(api.detect(images[16]).names, []);
    });
    await test('code and raw BBCode are not column headings', () => {
        for (const content of ['<code>Source - Encode</code>', '[color=red]Source[/color] - Encode']) {
            const root = fixture(`<pre>${content}</pre><div>${img('a')}${img('b')}</div>`);
            equal(api.scan(root, root).headings, []);
            equal(api.detect(root.querySelector('img')).names, []);
        }
    });
    await test('nonbreaking-space headings split comparison sections and detect all four columns', () => {
        const gap = ' &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; ';
        const root = fixture(`<center><font size="2"><br>
            <b>SOURCE${gap}<span>SOURCE(FEL)</span>${gap}GroupA${gap}GroupB</b><br><br>
            ${Array.from({ length: 8 }, (_, i) => img(`first-${i}`)).join(' ')}<br><br>
            MORE SCREENSHOTS<br><br>
            <b>SOURCE${gap}SOURCE(FEL)${gap}GroupA${gap}OLD GroupA</b><br><br>
            ${Array.from({ length: 4 }, (_, i) => img(`second-${i}`)).join(' ')}<br>
            </font></center>`);
        const images = [...root.querySelectorAll('img')];
        for (let i = 0; i < images.length; i++) {
            const area = api.detect(images[i]);
            equal(area.names, ['SOURCE', 'SOURCE(FEL)', 'GroupA', i < 8 ? 'GroupB' : 'OLD GroupA']);
            equal(area.images.map(item => item.source), images.slice(i < 8 ? 0 : 8, i < 8 ? 8 : 12).map(image => image.src));
        }
        equal(calls.length, 0);
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
    await test('ex12 comma heading stays local to its screenshots instead of borrowing technical labels', () => {
        for (const heading of ['Source, GroupA, GroupB', 'Screenshots']) {
            const root = fixture(`<table><tbody><tr><td>
                <div>Technical Information - <a href="/mediainfo">Mediainfo log</a></div>
                <table><tr><th>Runtime</th><td>1:43:00</td></tr></table>
                <div>Subtitles</div>${img('flag-a')}${img('flag-b')}
                </td></tr><tr><td><p>Quote</p><table><tr><td>
                <strong>GroupName PRESENTS<br>Technical Information:<br>BITRATE: 12.8 Mb/s<br>
                NOTES:<br>Banding fixed.<br><br><div align="center">${heading}</div></strong><br>
                <div class="gallery" align="center">${Array.from({ length: 30 }, (_, i) => img(`screen-${i}`)).join(' ')}</div>
                </td></tr></table></td></tr>
                <tr><td>Other copies${img('other-copy')}</td></tr></tbody></table>`);
            const gallery = root.querySelector('.gallery');
            const images = [...gallery.querySelectorAll('img')];
            for (const target of [gallery, ...images]) {
                const area = api.detect(target);
                equal(area.names, heading === 'Screenshots' ? [] : ['Source', 'GroupA', 'GroupB']);
                equal(area.images.map(item => item.source), images.map(image => image.src));
            }
        }
    });
    await test('nearby names remain available across blank lines, wrappers and matching image captions', () => {
        const root = fixture(`<section><b>Filtered Source - GroupA</b><br><br>
            <div><figure><figcaption>Filtered Source</figcaption>${img('a')}</figure>
            <figure><figcaption>GroupA</figcaption>${img('b')}</figure></div></section>`);
        for (const target of [root, ...root.querySelectorAll('img')]) {
            const area = api.detect(target);
            equal(area.names, ['Filtered Source', 'GroupA']);
            equal(area.images.length, 2);
        }
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
                equal(area.images.length, 20);
                equal(area.names.slice(0, 2), ['SOURCE', 'SOURCE(FEL)']);
                equal(area.names.length, 4);
                equal(area.images[0].link, 'https://pixhost.cc/show/5385/764953339_1-source-040774.png');
                equal(area.images[0].source, 'https://t3.pixhost.cc/thumbs/5385/764953339_1-source-040774.png');
                const second = api.detect(find('764954444_'));
                equal(second.images.length, 12);
                equal(second.names.slice(0, 2), ['SOURCE', 'SOURCE(FEL)']);
                equal(second.names.length, 4);
            } else if (name === 'ex3' || name === 'ex7') {
                const area = api.detect(name === 'ex3' ? find('Nightcrawler') : find('screenshots/'));
                equal(area.images.length, name === 'ex3' ? 14 : 16);
                equal(area.names, []);
            } else if (name === 'ex4') {
                const groups = root.querySelectorAll('.comparison');
                equal([...groups].map(group => api.detect(group.querySelector('button')).images.length), [30, 30, 30]);
                equal(api.detect(groups[0].querySelector('button')).names.length, 2);
            } else if (name === 'ex5') {
                const area = api.detect(find('img4k.net'));
                equal(area.images.filter(item => item.link).length, 12);
                equal(area.names, []);
            } else if (name === 'ex6') {
                const area = api.detect(find('img4k.net'));
                equal(area.images.length, 12);
                equal(area.names, ['SOURCE', 'ENCODE']);
            } else if (name === 'ex10') {
                const area = api.detect(images[0]);
                equal(area.images.length, 28);
                equal(area.names, ['Source', 'Encode']);
            } else if (name === 'ex11') {
                const area = api.detect(find(`t.${imageHostDomain}`));
                equal(area.images.length, 24);
                equal(area.names.slice(0, 2), ['SOURCE', 'ENCODE']);
                equal(area.names.length, 4);
            } else if (name === 'ex12') {
                const screenshots = images.filter(image => image.src.includes(`t.${imageHostDomain}`));
                equal(screenshots.length, 30);
                for (const image of screenshots) {
                    const area = api.detect(image);
                    equal(area.names[0], 'Source');
                    equal(area.names.length, 3);
                    equal(area.images.map(item => item.source), screenshots.map(image => image.src));
                }
            } else if (name === 'ex8') {
                const area = api.detect(find('i.ibb.co'));
                equal(area.images.length, 16);
                equal(area.names.length, 2);
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
    const pngBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    const png = new Blob([pngBytes], { type: 'image/png' });
    // Accept only the known fixture; decoder failures test the script's error handling.
    globalThis.createImageBitmap = async blob => {
        equal([...new Uint8Array(await blob.arrayBuffer())], [...pngBytes]);
        return { close() {} };
    };
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
        ok(messages.at(-1).includes('Stopped — ZIP download incomplete.'));
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
    await test('TMDB linking validates typed references and encodes movie and TV links without lookups', async () => {
        calls.length = 0;
        equal(api.tmdbReference(' movie/00123 '), 'MOVIE_123');
        equal(api.tmdbReference('TV/456'), 'TV_456');
        equal(api.tmdbReference(''), '');
        equal(api.tmdbReference('  '), '');
        for (const value of ['123', 'tv/0', 'tv/-1', 'movie/1.5', 'tv/1e3', 'tv/12abc', 'TV_123', 'movie/9007199254740992', 'tv/123/season/1']) {
            await rejects(() => api.tmdbReference(value), /TMDB id/);
        }
        await rejects(() => api.tmdbReference('person/123'), /TMDB id/);
        equal(calls.length, 0);
    });
    await test('TMDB menu saves and clears the key and refreshes the open dialog without changing its reference', async () => {
        calls.length = 0;
        ok(settingReads.every(key => ['tmdb_api_key', 'ptscreens_api_key', 'imgbb_api_key', 'image_bbcode_width'].includes(key)));
        ok(api.tmdbSearchSection.hidden && !api.tmdbSearchHint.hidden);
        ok(!api.tmdbInput.disabled && !api.tmdbInput.hidden);
        await api.findTMDB();
        equal(calls.length, 0);
        api.tmdbInput.value = 'tv/124';
        api.tmdbInput.dispatchEvent(new Event('input'));
        equal(api.tmdbReference(api.tmdbInput.value), 'TV_124');
        configureKey(' PRIVATE_SAVED_KEY ');
        equal([...savedSettings], [['tmdb_api_key', 'PRIVATE_SAVED_KEY']]);
        ok(!api.tmdbSearchSection.hidden && api.tmdbSearchHint.hidden);
        equal(api.tmdbInput.value, 'tv/124');
        const setValue = GM_setValue;
        GM_setValue = () => { throw new Error('storage unavailable'); };
        configureKey('not-saved');
        ok(alerts.at(-1).includes('Could not save'));
        equal(keyMenu().label, 'TMDB API key: configured');
        equal(savedSettings.get('tmdb_api_key'), 'PRIVATE_SAVED_KEY');
        GM_setValue = setValue;
        configureKey('');
        equal(savedSettings.get('tmdb_api_key'), '');
        ok(api.tmdbSearchSection.hidden);
        equal(api.tmdbInput.value, 'tv/124');
        api.tmdbInput.value = '';
        api.tmdbInput.dispatchEvent(new Event('input'));
        ok(!api.diagnostics.join('\n').includes('PRIVATE_SAVED_KEY'));
        equal(calls.length, 0);
    });
    await test('comparison fields include optional TMDB links only when set', () => {
        const job = { items: [{}, {}], names: ['GroupA', 'GroupB'], title: 'Example', public: false, browserId: 'id' };
        ok(!api.comparisonFields(job).has('tmdbId'));
        ok(!api.comparisonFields({ ...job, tmdbId: '' }).has('tmdbId'));
        for (const tmdbId of ['MOVIE_123', 'TV_456']) {
            const fields = api.comparisonFields({ ...job, tmdbId });
            equal(fields.getAll('tmdbId'), [tmdbId]);
            equal(fields.get('public'), 'false');
            equal(fields.get('comparisons[0].imageNames[1]'), 'GroupB');
        }
    });
    await test('TMDB title search sends the API key only to TMDB and redacts credentials and queries', async () => {
        calls.length = 0;
        handler = () => ({ responseText: JSON.stringify({ results: [
            { id: 123, title: 'Example Film', release_date: '2020-01-02' },
            { id: 124, title: 'Example Film', release_date: '1990-01-02' },
            { id: -1, title: 'Invalid' }
        ] }) });
        equal(await api.searchTMDB('MOVIE', 'PRIVATE_SEARCH_TITLE', 'PRIVATE_TMDB_KEY', controller().signal), [
            { id: '123', title: 'Example Film', year: '2020', countries: [], poster: '' }, { id: '124', title: 'Example Film', year: '1990', countries: [], poster: '' }
        ]);
        const request = calls[0], url = new URL(request.url);
        equal(url.origin, 'https://api.themoviedb.org');
        equal(url.pathname, '/3/search/movie');
        equal(url.searchParams.get('query'), 'PRIVATE_SEARCH_TITLE');
        equal(url.searchParams.get('api_key'), 'PRIVATE_TMDB_KEY');
        equal(request.anonymous, true);
        ok(!request.cookiePartition && !request.headers.Authorization && !request.headers['X-XSRF-TOKEN']);
        handler = () => ({ responseText: JSON.stringify({ results: [{ id: 456, name: 'Example Show' }] }) });
        equal(await api.searchTMDB('TV', 'Example Show', 'PRIVATE_TMDB_KEY', controller().signal),
            [{ id: '456', title: 'Example Show', year: 'Unknown year', countries: [], poster: '' }]);
        equal(new URL(calls[1].url).pathname, '/3/search/tv');
        equal(new URL(calls[1].url).searchParams.get('api_key'), 'PRIVATE_TMDB_KEY');
        ok(!calls[1].headers.Authorization);
        ok(!/PRIVATE_SEARCH_TITLE|PRIVATE_TMDB/.test(api.diagnostics.join('\n')));
        equal(calls.length, 2);
    });
    await test('TMDB search handles missing credentials, failed authentication and malformed or empty results', async () => {
        calls.length = 0;
        await rejects(() => api.searchTMDB('MOVIE', 'Example', '', controller().signal), /TMDB API key/);
        await rejects(() => api.searchTMDB('MOVIE', '', 'key', controller().signal), /title/);
        equal(calls.length, 0);
        handler = () => ({ status: 401 });
        await rejects(() => api.searchTMDB('MOVIE', 'Example', 'key', controller().signal), /rejected the API key/);
        for (const responseText of ['not json', '{}']) {
            handler = () => ({ responseText });
            await rejects(() => api.searchTMDB('MOVIE', 'Example', 'key', controller().signal), /invalid search response/);
        }
        handler = () => ({ responseText: '{"results":[]}' });
        equal(await api.searchTMDB('MOVIE', 'Example', 'key', controller().signal), []);
        handler = () => ({ status: 429, responseHeaders: 'Retry-After: 120' });
        await rejects(() => api.searchTMDB('MOVIE', 'Example', 'key', controller().signal), /rate limit/);
        const count = calls.length;
        await rejects(() => api.searchTMDB('MOVIE', 'Example', 'key', controller().signal), /rate limit/);
        equal(calls.length, count);
        api.retryAfter.delete('https://api.themoviedb.org');
    });
    await test('TMDB media type recognizes TV markers and defaults to movies', () => {
        for (const title of ['Example.Show.S02E03.1080p', 'Example S01 720p', 'Example Season 2', 'Example 1x03', 'Example Episode 12']) {
            equal(api.suggestedMediaType(title), 'TV');
        }
        for (const title of ['Example Film 2020 1080p', 'Example Film', '']) equal(api.suggestedMediaType(title), 'MOVIE');
    });
    await test('TMDB results show countries and safe posters, tolerate missing metadata, and support keyboard selection', async () => {
        configureKey('test-key');
        api.tmdbType.value = 'MOVIE';
        api.tmdbQuery.value = 'Example';
        handler = options => ({ responseText: JSON.stringify(options.url.includes('/search/') ? { results: [
            { id: 101, title: '<Example Film>', release_date: '2020-01-01', poster_path: '/poster.jpg' },
            { id: 102, title: 'Example Film', poster_path: 'https://untrusted.test/poster.jpg' }
        ] } : { production_countries: [{ iso_3166_1: 'US' }, { iso_3166_1: 'CA' }] }) });
        await api.findTMDB();
        equal(api.tmdbResults.children.length, 2);
        equal(api.tmdbResults.querySelector('.tmdb-country').textContent, 'United States, Canada');
        equal(api.tmdbResults.querySelector('img').src, 'https://image.tmdb.org/t/p/w92/poster.jpg');
        equal(api.tmdbResults.querySelectorAll('img').length, 1);
        ok(!api.tmdbResults.querySelector('example'));
        equal(api.tmdbSearchStatus.textContent, '');
        ok(!api.dialog.textContent.includes('Manual references need no API key.'));
        api.tmdbResultsButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        equal(api.tmdbResultsButton.getAttribute('aria-expanded'), 'true');
        equal(api.tmdbResults.getRootNode().activeElement, api.tmdbResults.children[0]);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
        ok(api.tmdbResults.hidden && document.getElementById('screen-export-dialog'));
        api.tmdbResultsButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
        equal(api.tmdbResults.getRootNode().activeElement, api.tmdbResults.children[1]);
        api.tmdbResults.children[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
        equal(api.tmdbResults.getRootNode().activeElement, api.tmdbResults.children[1]);
        api.tmdbResults.children[1].click();
        equal(api.tmdbInput.value, 'movie/102');
        equal(api.tmdbResults.children[1].getAttribute('aria-selected'), 'true');
        api.tmdbInput.value = '';
        api.tmdbInput.dispatchEvent(new Event('input'));
        equal(api.tmdbResults.children[1].getAttribute('aria-selected'), 'false');
        api.tmdbResults.querySelector('img').dispatchEvent(new Event('error'));
        equal(api.tmdbResults.querySelectorAll('img').length, 0);
        handler = options => options.url.includes('/search/')
            ? { responseText: JSON.stringify({ results: [{ id: 103, title: 'Example' }] }) } : { status: 503 };
        await api.findTMDB();
        equal(api.tmdbResults.querySelector('.tmdb-country').textContent, 'Unknown country');
        ok(!api.tmdbResultsButton.disabled);
        api.tmdbType.value = 'TV';
        handler = () => ({ responseText: JSON.stringify({ results: [{ id: 104, name: 'Example', origin_country: ['GB', 'invalid'] }] }) });
        calls.length = 0;
        await api.findTMDB();
        equal(calls.length, 1);
        equal(api.tmdbResults.querySelector('.tmdb-country').textContent, 'United Kingdom');
        api.tmdbType.value = 'MOVIE';
        api.tmdbType.dispatchEvent(new Event('change'));
    });
    await test('TMDB country lookups stop on rate limits and are cancelled when a query changes', async () => {
        calls.length = 0;
        const results = [{ id: 101, title: 'Example A' }, { id: 102, title: 'Example B' }];
        handler = options => options.url.includes('/search/') ? { responseText: JSON.stringify({ results }) }
            : { status: 429, responseHeaders: 'Retry-After: 120' };
        await api.findTMDB();
        equal(calls.length, 2);
        equal(api.tmdbResults.children.length, 2);
        ok(!api.tmdbResultsButton.disabled);
        api.retryAfter.delete('https://api.themoviedb.org');
        calls.length = 0;
        handler = options => options.url.includes('/search/') ? { responseText: JSON.stringify({ results }) } : null;
        const pending = api.findTMDB();
        for (let i = 0; i < 30 && calls.length < 2; i++) await Promise.resolve();
        equal(calls.length, 2);
        equal(api.tmdbResults.children.length, 2);
        ok(!api.tmdbSearchButton.disabled);
        api.tmdbQuery.value = 'Another title';
        api.tmdbQuery.dispatchEvent(new Event('input'));
        await pending;
        equal(calls.length, 2);
        equal(api.tmdbResults.children.length, 0);
        ok(api.tmdbResultsButton.disabled);
    });
    await test('TMDB dropdown selects movie/TV IDs, cancels stale searches and never searches on input', async () => {
        calls.length = 0;
        api.tmdbQuery.value = 'Example';
        api.tmdbQuery.dispatchEvent(new Event('input'));
        configureKey('test-key');
        equal(calls.length, 0);
        handler = () => ({ responseText: JSON.stringify({ results: [{ id: 123, title: 'Example Film', release_date: '2020-01-01' }] }) });
        await api.findTMDB();
        equal(new URL(calls[0].url).searchParams.get('api_key'), 'test-key');
        equal(api.tmdbInput.value, '');
        ok(api.tmdbResults.children[0].textContent.includes('Example Film (2020) · ID 123'));
        api.tmdbResultsButton.click();
        ok(!api.tmdbResults.hidden);
        api.tmdbResults.children[0].click();
        ok(api.tmdbResults.hidden);
        equal(api.tmdbInput.value, 'movie/123');
        api.tmdbType.value = 'TV';
        api.tmdbType.dispatchEvent(new Event('change'));
        equal(api.tmdbInput.value, '');
        ok(api.tmdbResultsButton.disabled);
        handler = () => ({ responseText: JSON.stringify({ results: [{ id: 456, name: 'Example Show', first_air_date: '2021-01-01' }] }) });
        await api.findTMDB();
        api.tmdbResults.children[0].click();
        equal(api.tmdbReference(api.tmdbInput.value), 'TV_456');
        handler = () => null;
        const pending = api.findTMDB();
        await Promise.resolve();
        api.tmdbQuery.value = 'Another show';
        api.tmdbQuery.dispatchEvent(new Event('input'));
        await pending;
        equal(api.tmdbResults.children.length, 0);
        ok(!api.tmdbSearchButton.disabled);
        handler = () => ({ responseText: '{"results":[]}' });
        await api.findTMDB();
        ok(api.tmdbResultsButton.disabled && api.tmdbSearchStatus.textContent.includes('No matches'));
        ok(calls.every(call => new URL(call.url).origin === 'https://api.themoviedb.org'));
        api.tmdbType.value = 'MOVIE';
        api.tmdbType.dispatchEvent(new Event('change'));
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
            names: ['Source', 'Encode'], title: 'A < B', public: true, tmdbId: 'TV_456', browserId: 'browser-id', done: 0 };
        await rejects(() => api.upload(job, controller().signal, () => {}), /HTTP 503/);
        equal(job.done, 1);
        ok(job.pending);
        equal(await api.upload(job, controller().signal, () => {}), 'https://slow.pics/c/key');
        equal(job.done, 2);
        equal(job.pending, null);
        const creates = calls.filter(call => call.url.endsWith('/upload/comparison'));
        equal(creates.length, 1);
        equal(creates[0].data.get('public'), 'true');
        equal(creates[0].data.get('tmdbId'), 'TV_456');
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
        ok(uploads.every(call => !call.data.has('tmdbId')));
        ok(uploads.every(call => call.cookiePartition.topLevelSite === 'https://slow.pics' && call.anonymous === false));
    });
    await test('comparison BBCode matches the requested format and preserves row-major image order', async () => {
        const job = { done: 2, items: [{}, {}], names: ['GroupA', 'GroupB'], collection: { key: 'example' } };
        const urls = ['https://i.slow.pics/first.png', 'https://i.slow.pics/second.webp'];
        equal(api.comparisonBBCode(job, urls), '[url=https://slow.pics/c/example]GroupA vs GroupB | Slowpoke Pics[/url]\n'
            + '[comparison=GroupA, GroupB]\nhttps://i.slow.pics/first.png\nhttps://i.slow.pics/second.webp\n[/comparison]');
        const many = { ...job, done: 6, items: Array(6).fill({}), names: ['GroupA', 'GroupB', 'GroupC'] };
        const ordered = Array.from({ length: 6 }, (_, i) => `https://i.slow.pics/image${i}.png`);
        equal(api.comparisonBBCode(many, ordered).split('\n').slice(2, -1), ordered);
        await rejects(() => api.comparisonBBCode({ ...job, done: 1 }, urls), /match all/);
        await rejects(() => api.comparisonBBCode(job, urls.slice(0, 1)), /match all/);
        await rejects(() => api.comparisonBBCode(job, [urls[0], 'javascript:alert(1)']), /match all/);
        await rejects(() => api.comparisonBBCode(job, [urls[0], 'https://images.test/original.png']), /match all/);
        await rejects(() => api.comparisonBBCode({ ...job, names: ['GroupA, GroupB', 'GroupC'] }, urls), /column names/);
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
    await test('downloads save one ZIP with safe UTF-8 filenames and unchanged image bytes', async () => {
        handler = imageResponse;
        const saved = [], messages = [];
        GM_download = options => {
            saved.push(options);
            queueMicrotask(() => options.onload());
            return { abort() {} };
        };
        await api.download([{ source: 'https://images.test/a.png' }, { source: 'https://images.test/b.png' }],
            ['Source', 'Grüp:名'], controller().signal, message => messages.push(message));
        equal(saved.map(item => item.name), ['Comparison.zip']);
        const entries = await readZIP(saved[0].url);
        equal(entries.map(file => file.name), ['Source0001.png', 'Grüp_名0001.png']);
        equal(entries.map(file => file.bytes), [[...pngBytes], [...pngBytes]]);
        equal(saved[0].conflictAction, 'prompt');
        equal(messages.at(-1), 'Saved Comparison.zip — 2 images.');
    });
    await test('ZIP archive titles are safe filenames with a fallback for empty names', async () => {
        handler = imageResponse;
        const saved = [];
        GM_download = options => { saved.push(options.name); queueMicrotask(() => options.onload()); return { abort() {} }; };
        for (const [title, expected] of [
            ['Movie Name 1976 2160p - Source vs Encode vs GroupA', 'Movie Name 1976 2160p - Source vs Encode vs GroupA.zip'],
            [' ../Movie: "Name" / GroupA\\GroupB?*<>|\n. ', '.._Movie_ _Name_ _ GroupA_GroupB______.zip'],
            ['', 'Comparison.zip'], [' ... ', 'Comparison.zip'], ['CON', '_CON.zip'],
            ['Grüp 名', 'Grüp 名.zip'], ['A'.repeat(200), `${'A'.repeat(180)}.zip`]
        ]) {
            const messages = [];
            await api.download([{ source: 'https://images.test/a.png' }], ['Image'], controller().signal,
                message => messages.push(message), title);
            equal(saved.at(-1), expected);
            equal(messages.at(-1), `Saved ${expected} — 1 images.`);
        }
    });
    await test('ZIP fetch failures stop subsequent requests and never save a partial archive', async () => {
        for (const response of [{ status: 503 }, { response: new Blob(['not an image']) }]) {
            calls.length = 0;
            handler = () => calls.length === 2 ? response : imageResponse();
            let saved = 0;
            GM_download = () => { saved++; };
            const messages = [];
            await api.download(['a', 'b', 'c'].map(id => ({ source: `https://images.test/${id}.png` })),
                ['Image'], controller().signal, message => messages.push(message));
            equal(calls.length, 2);
            equal(saved, 0);
            ok(messages.at(-1).startsWith('Stopped — ZIP download incomplete.'));
        }
    });
    await test('ZIP save errors and cancellation never report success', async () => {
        handler = imageResponse;
        for (const cancel of [false, true]) {
            const active = controller(), messages = [];
            let attempts = 0, aborted = 0;
            GM_download = options => {
                attempts++;
                queueMicrotask(() => cancel ? active.abort() : options.onerror({ error: 'not_whitelisted' }));
                return { abort() { aborted++; } };
            };
            await api.download([{ source: 'https://images.test/a.png' }], ['Image'], active.signal, message => messages.push(message));
            equal(attempts, 1);
            equal(aborted, cancel ? 1 : 0);
            ok(messages.at(-1).includes(cancel ? 'Cancelled' : 'not_whitelisted'));
            ok(!messages.at(-1).includes('Saved'));
        }
    });
    await test('cancelling image collection stops subsequent requests without saving a ZIP', async () => {
        calls.length = 0;
        const active = controller(), messages = [];
        handler = () => { active.abort(); return imageResponse(); };
        let saved = 0;
        GM_download = () => { saved++; };
        await api.download(['a', 'b'].map(id => ({ source: `https://images.test/${id}.png` })),
            ['Image'], active.signal, message => messages.push(message));
        equal(calls.length, 1);
        equal(saved, 0);
        equal(messages.at(-1), 'Cancelled — ZIP download incomplete.');
    });
    await test('ZIP checksums cover multiple chunks and ZIP size limits fail before reading data', async () => {
        const data = new Uint8Array(1024 * 1024 + 17).map((_, i) => i % 251);
        const entries = await readZIP(await api.zipArchive([{ name: 'GroupA0001.jpg', blob: new Blob([data]) }], controller().signal));
        equal(entries[0].bytes, [...data]);
        const tooLarge = { name: 'Image.png', blob: { size: 0xffffffff, slice() { throw new Error('Unexpected read'); } } };
        await rejects(() => api.zipArchive([tooLarge], controller().signal), /smaller than 4 GiB/);
        await rejects(() => api.zipArchive(Array(65535).fill(tooLarge), controller().signal), /Too many images/);
        const active = controller();
        const interrupted = { name: 'Image.png', blob: { size: 1, slice() { active.abort(); return new Blob(['x']); } } };
        await rejects(() => api.zipArchive([interrupted], active.signal), /Cancelled/);
    });
    await test('column order groups selected images consistently in previews, downloads and upload slots', async () => {
        document.title = 'Movie.Name.1976.2160p.BluRay-GroupName :: Site';
        const images = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => ({ source: `https://images.test/${name}.png`, preview: `https://images.test/${name}.png` }));
        api.showArea({ root: document.body, images, names: ['GroupA', 'GroupB'] });
        [...api.dialog.querySelectorAll('button')].find(button => button.textContent === 'Select all').click();
        equal(api.imageOrder.value, 'rows');
        equal(api.selectedImages().map(item => item.source), images.map(item => item.source));
        api.imageOrder.value = 'columns';
        api.imageOrder.dispatchEvent(new Event('change'));
        const expected = ['a', 'd', 'b', 'e', 'c', 'f'].map(name => `https://images.test/${name}.png`);
        equal([...api.preview.querySelectorAll('img')].map(img => img.src), expected);
        equal([...api.preview.querySelectorAll('figcaption')].map(node => node.textContent),
            ['0001 · GroupA', '0001 · GroupB', '0002 · GroupA', '0002 · GroupB', '0003 · GroupA', '0003 · GroupB']);
        calls.length = 0;
        handler = imageResponse;
        const saved = [];
        GM_download = options => { saved.push(options); queueMicrotask(() => options.onload()); return { abort() {} }; };
        await api.run('download');
        equal(calls.map(call => call.url), expected);
        equal(saved.map(item => item.name), ['Movie Name 1976 2160p - GroupA vs GroupB.zip']);
        const archiveNames = (await readZIP(saved[0].url)).map(file => file.name);
        equal(archiveNames, ['GroupA0001.png', 'GroupB0001.png', 'GroupA0002.png', 'GroupB0002.png', 'GroupA0003.png', 'GroupB0003.png']);
        api.title.value = 'Custom collection';
        api.title.dispatchEvent(new Event('input'));
        await api.run('download');
        equal(saved.at(-1).name, 'Custom collection.zip');
        api.title.value = '';
        api.title.dispatchEvent(new Event('input'));
        await api.run('download');
        equal(saved.at(-1).name, 'Movie Name 1976 2160p - GroupA vs GroupB.zip');
        api.state.customTitle = false;
        calls.length = 0;
        handler = options => {
            if (options.url.endsWith('/comparison') && options.method === 'GET') return { responseHeaders: 'Set-Cookie: XSRF-TOKEN=token;', responseText: '' };
            if (options.url.endsWith('/upload/comparison')) return { responseText: JSON.stringify({ collectionUuid: 'collection', key: 'key', images: [['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3']] }) };
            if (options.url.endsWith('/upload/image')) return { responseText: 'OK' };
            return imageResponse();
        };
        await api.run('upload');
        equal(calls.filter(call => call.url.startsWith('https://images.test/')).map(call => call.url), expected);
        const uploads = calls.filter(call => call.url.endsWith('/upload/image'));
        equal(uploads.map(call => call.data.get('imageUuid')), ['a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
        equal(uploads.map(call => call.data.get('file').name), archiveNames);
        ok(api.imageOrder.matches(':disabled'));
        api.resetButton.click();
        api.columns.value = '3';
        api.columns.dispatchEvent(new Event('change'));
        equal(api.selectedImages().map(item => item.source), [images[0], images[2], images[4], images[1], images[3], images[5]].map(item => item.source));
        api.columns.value = '2';
        api.columns.dispatchEvent(new Event('change'));
        api.candidates.children[1].click();
        ok(api.uploadButton.disabled && api.downloadButton.disabled);
        api.candidates.children[4].click();
        equal(api.selectedImages().map(item => item.source), [images[0], images[3], images[2], images[5]].map(item => item.source));
        api.imageOrder.value = 'rows';
        api.imageOrder.dispatchEvent(new Event('change'));
        api.chooseArea();
    });
    await test('picker suppresses site clicks, selection updates the grid and incomplete rows block both outputs', async () => {
        document.title = 'Hot Dog 2018 1080p BluRay DTS x264-GroupName :: SITE';
        const root = fixture(`<div><b>Source vs Encode</b><br>${img('a')}${img('b')}${img('c')}${img('d')}</div>`);
        document.body.append(root);
        let pageClicks = 0;
        root.addEventListener('click', event => { pageClicks++; event.preventDefault(); });
        root.querySelector('img').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        equal(pageClicks, 0);
        equal(api.state.images.length, 4);
        equal(api.state.selected.size, 0);
        equal(api.publicInput.checked, false);
        equal(api.tmdbInput.value, '');
        equal(api.title.value, 'Hot Dog 2018 1080p - Source vs Encode');
        api.names.children[1].value = 'GroupB';
        api.names.children[1].dispatchEvent(new Event('input'));
        equal(api.title.value, 'Hot Dog 2018 1080p - Source vs GroupB');
        ok(api.dialog.open && api.picker.hidden);
        api.candidates.children[0].click();
        api.candidates.children[3].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
        equal(api.state.selected.size, 4);
        ok(!api.uploadButton.disabled);
        equal(api.preview.children.length, 4);
        calls.length = 0;
        api.tmdbInput.value = 'invalid';
        api.tmdbInput.dispatchEvent(new Event('input'));
        ok(api.uploadButton.disabled && !api.downloadButton.disabled);
        ok(!api.tmdbError.hidden);
        await api.run('upload');
        equal(api.state.job, null);
        equal(calls.length, 0);
        ok(api.status.textContent.includes('TMDB id'));
        api.tmdbInput.value = 'movie/123';
        api.tmdbInput.dispatchEvent(new Event('input'));
        equal(api.tmdbType.value, 'MOVIE');
        ok(!api.uploadButton.disabled && api.tmdbError.hidden);
        api.columns.value = '3';
        api.columns.dispatchEvent(new Event('change'));
        ok(api.uploadButton.disabled);
        ok(api.downloadButton.disabled);
        ok(api.summary.textContent.includes('incomplete'));
        equal(api.names.children.length, 3);
        equal(api.title.value, 'Hot Dog 2018 1080p - Source vs GroupB vs Column 3');
        api.title.value = 'My collection';
        api.title.dispatchEvent(new Event('input'));
        // A failed upload must lock its mapping until resumed or explicitly reset.
        api.columns.value = '2';
        api.columns.dispatchEvent(new Event('change'));
        equal(api.title.value, 'My collection');
        calls.length = 0;
        handler = options => options.url.endsWith('/comparison') && options.method === 'GET'
            ? { responseHeaders: 'Set-Cookie: XSRF-TOKEN=token;' }
            : options.url.endsWith('/upload/comparison')
                ? { responseText: JSON.stringify({ collectionUuid: 'c', key: 'k', images: [['a', 'b'], ['c', 'd']] }) }
                : options.method === 'POST' ? { status: 503 } : imageResponse();
        await api.run('upload');
        ok(api.settings.disabled);
        equal(api.uploadButton.textContent, 'Retry upload');
        ok(api.state.job.collection);
        equal(api.state.job.public, false);
        const creation = calls.find(call => call.url.endsWith('/upload/comparison'));
        equal(creation.data.get('public'), 'false');
        equal(creation.data.get('tmdbId'), 'MOVIE_123');
        equal(api.state.job.tmdbId, 'MOVIE_123');
        ok(api.tmdbInput.matches(':disabled') && api.tmdbType.matches(':disabled'));
        equal(api.state.job.title, 'My collection');
        ok(api.status.textContent.includes('incomplete'));
        api.resetButton.click();
        equal(api.state.job, null);
        ok(!api.settings.disabled);
        api.tmdbType.value = 'TV';
        api.tmdbType.dispatchEvent(new Event('change'));
        api.tmdbInput.value = 'tv/123';
        api.tmdbInput.dispatchEvent(new Event('input'));
        calls.length = 0;
        await api.run('upload');
        equal(api.state.job.tmdbId, 'TV_123');
        equal(calls.find(call => call.url.endsWith('/upload/comparison')).data.get('tmdbId'), 'TV_123');
        api.resetButton.click();
        api.tmdbInput.value = '';
        api.tmdbInput.dispatchEvent(new Event('input'));
        calls.length = 0;
        await api.run('upload');
        ok(!calls.find(call => call.url.endsWith('/upload/comparison')).data.has('tmdbId'));
        api.resetButton.click();
        launchFromMenu();
        equal(document.querySelectorAll('#screen-export-dialog').length, 1);
        api.dialog.querySelector('button[aria-label="Close"]').click();
        equal(menus.size, 4);
        root.querySelector('img').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        equal(pageClicks, 1);
        root.remove();
        ok(!document.getElementById('screen-export-dialog'));
    });
    await test('Escape removes the picker and its temporary click listeners', () => {
        document.title = 'Example.Show.S02E03.1080p';
        launchFromMenu();
        equal(screenExport.tmdbType.value, 'TV');
        equal(savedSettings.get('tmdb_api_key'), 'test-key');
        ok(!screenExport.tmdbSearchSection.hidden);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
        ok(!document.getElementById('screen-export-dialog'));
        const click = new MouseEvent('click', { bubbles: true, cancelable: true });
        document.body.dispatchEvent(click);
        ok(!click.defaultPrevented);
    });
    // Standalone workflows use the same mocked DOM and transfers, in a fresh dialog.
    launchFromMenu();
    const imagesAPI = screenExport;
    const standaloneItems = Array.from({ length: 3 }, (_, i) => ({ source: `https://images.test/standalone-${i}.png`, preview: `https://images.test/standalone-${i}.png` }));
    const chooseHost = value => { imagesAPI.destination.value = value; imagesAPI.destination.dispatchEvent(new Event('change')); };
    const setWidth = value => { imagesAPI.width.value = value; imagesAPI.width.dispatchEvent(new Event('input')); };
    const setHostKey = (host, value) => {
        promptValue = value;
        [...menus.values()].find(menu => menu.label.startsWith(`${host} API key:`)).callback();
    };
    const hostResponse = (host, id = 'one') => ({ responseText: JSON.stringify(host === 'pixhost'
        ? { show_url: `https://pixhost.to/show/123/${id}.png`, th_url: `https://t12.pixhost.to/thumbs/123/${id}.png` }
        : { success: true, status_code: 200, data: { url_viewer: `https://${host === 'imgbb' ? 'ibb.co' : 'ptscreens.com/image'}/${id}`,
            image: { url: `https://${host === 'imgbb' ? 'i.ibb.co' : 'img.ptscreens.com'}/${id}.png` },
            display_url: 'https://images.test/resized.png', medium: { url: 'https://images.test/medium.png' } } }) });
    await test('standalone mode accepts odd selections and ignores hidden comparison settings', async () => {
        calls.length = 0;
        imagesAPI.showArea({ root: null, images: standaloneItems, names: ['GroupA', 'GroupB'] });
        imagesAPI.candidates.children[0].click();
        imagesAPI.candidates.children[2].dispatchEvent(new MouseEvent('click', { shiftKey: true }));
        imagesAPI.imageOrder.value = 'columns';
        imagesAPI.tmdbInput.value = 'invalid';
        imagesAPI.names.children[1].value = 'GroupA';
        imagesAPI.update();
        ok(imagesAPI.uploadButton.disabled);
        chooseHost('pixhost');
        ok(!imagesAPI.uploadButton.disabled && !imagesAPI.downloadButton.disabled);
        equal(imagesAPI.selectedImages().map(item => item.source), standaloneItems.map(item => item.source));
        ok([...imagesAPI.dialog.querySelectorAll('.comparison-only')].every(node => node.hidden));
        equal(imagesAPI.width.value, '');
        equal(calls.length, 0);
        chooseHost('slowpics');
        ok(imagesAPI.uploadButton.disabled && imagesAPI.downloadButton.disabled);
        ok([...imagesAPI.dialog.querySelectorAll('.comparison-only')].every(node => !node.hidden));
        chooseHost('ptscreens');
        await imagesAPI.run('upload');
        equal(calls.length, 0);
        ok(imagesAPI.status.textContent.includes('PTScreens API key'));
        ok(!imagesAPI.state.job);
    });
    await test('standalone key prompts save, clear and cancel without exposing saved keys', () => {
        for (const [host, storage] of [['PTScreens', 'ptscreens_api_key'], ['ImgBB', 'imgbb_api_key']]) {
            setHostKey(host, ` ${host}_SECRET `);
            equal(savedSettings.get(storage), `${host}_SECRET`);
            setHostKey(host, null);
            equal(savedSettings.get(storage), `${host}_SECRET`);
            setHostKey(host, '');
            equal(savedSettings.get(storage), '');
            setHostKey(host, `${host}_SECRET`);
        }
        ok(!imagesAPI.uploadButton.disabled);
        equal(menus.size, 4);
        ok(prompts.every(prompt => prompt.value === ''));
        ok(!JSON.stringify(prompts).includes('PTScreens_SECRET'));
    });
    await test('host adapters preserve bytes, use correct fields and isolate credentials', async () => {
        calls.length = 0;
        for (const host of ['ptscreens', 'imgbb', 'pixhost']) {
            handler = () => hostResponse(host);
            const result = await imagesAPI.uploadImage(host, { blob: png, extension: 'png' }, 'Image0001.png', false,
                host === 'ptscreens' ? 'PTScreens_SECRET' : host === 'imgbb' ? 'ImgBB_SECRET' : '', controller().signal);
            const call = calls.at(-1);
            equal(call.anonymous, true);
            equal(call.cookiePartition, undefined);
            equal(call.headers['X-XSRF-TOKEN'], undefined);
            equal(call.headers['Content-Type'], undefined);
            equal(call.redirect, 'error');
            if (host === 'ptscreens') {
                equal(call.url, 'https://ptscreens.com/api/1/upload');
                equal(call.headers['X-API-Key'], 'PTScreens_SECRET');
                equal([...atob(call.data.get('image'))].map(char => char.charCodeAt(0)), [...pngBytes]);
                equal([...call.data.keys()], ['image']);
                equal(result.originalUrl, 'https://img.ptscreens.com/one.png');
            } else {
                equal(call.headers['X-API-Key'], undefined);
                const file = call.data.get(host === 'imgbb' ? 'image' : 'img');
                equal(file.name, 'Image0001.png');
                equal(file.type, 'image/png');
                equal([...new Uint8Array(await file.arrayBuffer())], [...pngBytes]);
                if (host === 'imgbb') {
                    equal(call.url, 'https://api.imgbb.com/1/upload');
                    equal(call.data.get('key'), 'ImgBB_SECRET');
                    ok(!call.data.has('expiration'));
                    equal(result.originalUrl, 'https://i.ibb.co/one.png');
                } else {
                    equal(call.url, 'https://api.pixhost.to/images');
                    equal([...call.data.keys()], ['img', 'content_type']);
                    equal(call.data.get('content_type'), '0');
                    equal(result.originalUrl, 'https://img12.pixhost.to/images/123/one.png');
                }
            }
        }
        handler = () => hostResponse('pixhost');
        await imagesAPI.uploadImage('pixhost', { blob: png }, 'Image0001.png', true, '', controller().signal);
        equal(calls.at(-1).data.get('content_type'), '1');
        ok(!imagesAPI.diagnostics.join('').includes('_SECRET'));
    });
    await test('invalid host responses and unsafe BBCode URLs never count as success', async () => {
        for (const [host, data] of [
            ['imgbb', { success: false }], ['ptscreens', { status_code: 400 }], ['pixhost', {}],
            ['pixhost', { show_url: 'https://pixhost.to/show/a', th_url: 'https://images.test/thumb.png' }],
            ['imgbb', { success: true, data: { url_viewer: 'javascript:alert(1)', image: { url: 'https://images.test/a.png' } } }],
            ['ptscreens', { status_code: 200, data: { url_viewer: 'https://ptscreens.com/image/a', image: { url: 'https://images.test/a[img].png' } } }],
            ['imgbb', { success: true, data: { url_viewer: 'https://user:secret@ibb.co/a', image: { url: 'https://images.test/a.png' } } }]
        ]) await rejects(() => imagesAPI.imageUploadResult(host, data), /invalid upload result/);
        handler = () => ({ responseText: '<html>not JSON</html>' });
        await rejects(() => imagesAPI.uploadImage('imgbb', { blob: png }, 'Image0001.png', false, 'ImgBB_SECRET', controller().signal), /invalid upload response/);
        handler = () => { throw new Error('network error containing ImgBB_SECRET'); };
        await rejects(() => imagesAPI.uploadImage('imgbb', { blob: png }, 'Image0001.png', false, 'ImgBB_SECRET', controller().signal), /failed or timed out/);
        ok(!imagesAPI.diagnostics.join('').includes('ImgBB_SECRET'));
    });
    await test('host limits reject incompatible images without upload requests', async () => {
        calls.length = 0;
        for (const host of ['imgbb', 'pixhost']) {
            await rejects(() => imagesAPI.uploadImage(host, { blob: { size: 40 * 1024 * 1024, type: 'image/png' } }, 'Image0001.png', false, '', controller().signal), /exceeds/);
        }
        await rejects(() => imagesAPI.uploadImage('pixhost', { blob: new Blob(['BM'], { type: 'image/bmp' }) }, 'Image0001.bmp', false, '', controller().signal), /does not support/);
        equal(calls.length, 0);
    });
    await test('partial results remain copyable and retry skips successes with the latest saved key', async () => {
        calls.length = 0;
        chooseHost('imgbb');
        let posts = 0;
        handler = options => {
            if (options.method !== 'POST') return imageResponse();
            posts++;
            return posts === 2 ? { status: 503 } : hostResponse('imgbb', String(posts));
        };
        await imagesAPI.run('upload');
        equal(imagesAPI.state.job.done, 1);
        equal(imagesAPI.state.job.results.length, 1);
        ok(imagesAPI.bbcode.value.includes('https://i.ibb.co/1.png'));
        ok(!imagesAPI.copyBBCode.disabled);
        ok(imagesAPI.destination.matches(':disabled'));
        ok(!imagesAPI.width.matches(':disabled'));
        equal(imagesAPI.uploadButton.textContent, 'Retry upload');
        setHostKey('ImgBB', 'NEW_IMG_SECRET');
        setWidth('350');
        equal(imagesAPI.bbcode.value, '[url=https://ibb.co/1][img=350]https://i.ibb.co/1.png[/img][/url]');
        const beforeRetry = calls.length;
        await imagesAPI.run('upload');
        equal(imagesAPI.state.job.done, 3);
        equal(posts, 4);
        equal(calls.filter(call => call.method !== 'POST').length, 3);
        ok(calls.slice(beforeRetry).filter(call => call.method === 'POST').every(call => call.data.get('key') === 'NEW_IMG_SECRET'));
        equal(imagesAPI.bbcode.value.split(' ').length, 3);
        ok(imagesAPI.uploadButton.disabled);
        ok(calls.filter(call => call.method !== 'POST').every(call => !call.data && !call.headers?.['X-API-Key'] && !call.cookiePartition));
        ok(calls.every(call => !call.url.includes('slow.pics')));
        ok(!imagesAPI.diagnostics.join('').includes('NEW_IMG_SECRET'));
    });
    await test('BBCode width is persistent, validated and changes output without transfers', async () => {
        calls.length = 0;
        const originals = imagesAPI.state.job.results;
        equal(savedSettings.get('image_bbcode_width'), '350');
        setWidth('');
        equal(savedSettings.get('image_bbcode_width'), '');
        equal(imagesAPI.bbcode.value, originals.map(item => `[url=${item.pageUrl}][img]${item.originalUrl}[/img][/url]`).join(' '));
        for (const value of ['0', '-1', '1.5', '1e3', '350px', '9007199254740992']) {
            setWidth(value);
            ok(imagesAPI.copyBBCode.disabled && !imagesAPI.width.checkValidity());
            equal(savedSettings.get('image_bbcode_width'), '');
        }
        setWidth('400');
        ok(imagesAPI.width.checkValidity());
        let copied;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
        imagesAPI.copyBBCode.click();
        await Promise.resolve();
        equal(copied, imagesAPI.bbcode.value);
        equal(calls.length, 0);
    });
    await test('standalone downloads preserve page order and use sequential names', async () => {
        const pageTitle = document.title;
        document.title = 'Movie.Name.1976.2160p.BluRay-GroupName :: Site';
        imagesAPI.resetButton.click();
        equal(imagesAPI.result.children.length, 0);
        ok(!imagesAPI.destination.matches(':disabled'));
        const downloads = [];
        handler = () => imageResponse();
        calls.length = 0;
        GM_download = options => { downloads.push(options); queueMicrotask(() => options.onload({})); return { abort() {} }; };
        imagesAPI.title.value = 'Hidden comparison title';
        imagesAPI.title.dispatchEvent(new Event('input'));
        const previousHost = imagesAPI.destination.value;
        for (const host of ['ptscreens', 'imgbb', 'pixhost']) {
            chooseHost(host);
            calls.length = 0;
            await imagesAPI.run('download');
            equal(downloads.at(-1).name, 'Movie Name 1976 2160p.zip');
            equal(calls.map(call => call.url), imagesAPI.selectedImages().map(item => item.source));
        }
        document.title = 'Unrecognized page title';
        await imagesAPI.run('download');
        equal(downloads.at(-1).name, 'Comparison.zip');
        equal((await readZIP(downloads[0].url)).map(file => file.name), ['Image0001.png', 'Image0002.png', 'Image0003.png']);
        chooseHost(previousHost);
        document.title = pageTitle;
        imagesAPI.state.customTitle = false;
        GM_download = () => { throw new Error('Unexpected download'); };
    });
    await test('standalone cancellation preserves completed images and resumes the aborted image', async () => {
        calls.length = 0;
        chooseHost('pixhost');
        let posts = 0, pending;
        handler = options => {
            if (options.method !== 'POST') return imageResponse();
            if (++posts === 2) { pending(); return null; }
            return hostResponse('pixhost', String(posts));
        };
        const blocked = new Promise(resolve => { pending = resolve; });
        const running = imagesAPI.run('upload');
        await blocked;
        imagesAPI.state.active.abort();
        await running;
        equal(imagesAPI.state.job.done, 1);
        equal(posts, 2);
        ok(imagesAPI.status.textContent.includes('Cancelled'));
        ok(imagesAPI.bbcode.value.includes('/1.png'));
        handler = options => options.method === 'POST' ? hostResponse('pixhost', String(++posts)) : imageResponse();
        await imagesAPI.run('upload');
        equal(imagesAPI.state.job.done, 3);
        equal(posts, 4);
        equal(calls.filter(call => call.method !== 'POST').length, 3);
        imagesAPI.resetButton.click();
    });
    await test('standalone rate limits prevent early retries and challenges stop the batch', async () => {
        calls.length = 0;
        handler = options => options.method === 'POST'
            ? { status: 429, responseHeaders: 'Retry-After: 120' } : imageResponse();
        await imagesAPI.run('upload');
        equal(imagesAPI.state.job.done, 0);
        equal(calls.length, 2);
        await imagesAPI.run('upload');
        equal(calls.length, 2);
        ok(imagesAPI.status.textContent.includes('wait'));
        imagesAPI.retryAfter.clear();
        handler = () => ({ status: 403, responseHeaders: 'cf-mitigated: challenge' });
        await imagesAPI.run('upload');
        equal(calls.length, 3);
        equal(imagesAPI.state.job.done, 0);
        imagesAPI.resetButton.click();
    });
    await test('width survives closing and reopening, including an explicitly blank value', () => {
        imagesAPI.close();
        equal(imagesAPI.state.job, null);
        calls.length = 0;
        launchFromMenu();
        equal(screenExport.width.value, '400');
        equal(screenExport.destination.value, 'slowpics');
        screenExport.width.value = '';
        screenExport.width.dispatchEvent(new Event('input'));
        screenExport.close();
        launchFromMenu();
        equal(screenExport.width.value, '');
        equal(calls.length, 0);
        const root = fixture(`<div>${img('single')}</div>`);
        equal(screenExport.detect(root.querySelector('img')).images.length, 1);
        screenExport.close();
    });
    launchFromMenu();
    const comparisonAPI = screenExport;
    // Sanitized version of the embedded data in tmp/slowpics_page.html.
    const comparisonData = {
        key: 'collection-key', name: 'Example Film - GroupA vs GroupB',
        comparisons: [
            { key: 'first-row', name: '0001', images: [
                { name: 'GroupA', publicFileName: 'first-a.png' }, { name: 'GroupB', publicFileName: 'first-b.webp' }
            ] },
            { key: 'second-row', name: '0002', images: [
                { name: 'GroupA', publicFileName: 'second-a.jpg' }, { name: 'GroupB', publicFileName: 'second-b.png' }
            ] }
        ]
    };
    const pageHTML = data => `<img src="https://i.slow.pics/t/decoy.png">
        <script src="https://untrusted.test/script.js"></script><script>
        var messages = {"message":"unrelated"};
        var cdnUrl = "https:\\/\\/i.slow.pics\\/";
        var collection = ${JSON.stringify(data)};
        var currentComparisonIndex = 0;
        globalThis.untrustedExecuted = true;
        </script>`;
    const comparisonJob = { collection: { key: 'first-row' }, names: ['GroupA', 'GroupB'], items: [{}, {}, {}, {}], done: 4 };
    const expectedURLs = ['first-a.png', 'first-b.webp', 'second-a.jpg', 'second-b.png'].map(name => `https://i.slow.pics/${name}`);
    await test('saved-page data yields original comparison URLs in upload order without executing scripts', () => {
        equal(comparisonAPI.comparisonPageURLs(pageHTML(comparisonData), comparisonJob), expectedURLs);
        equal(comparisonAPI.comparisonPageURLs(pageHTML({ ...comparisonData, comparisons: [...comparisonData.comparisons].reverse() }), comparisonJob), expectedURLs);
        equal(comparisonAPI.comparisonPageURLs(pageHTML(comparisonData), { ...comparisonJob, collection: { key: 'collection-key' } }), expectedURLs);
        equal(globalThis.untrustedExecuted, undefined);
    });
    await test('comparison page parsing rejects missing, ambiguous, unsafe and mismatched data', async () => {
        await rejects(() => comparisonAPI.comparisonPageURLs('<html>Login required</html>', comparisonJob), /readable comparison data/);
        await rejects(() => comparisonAPI.comparisonPageURLs('<script>var collection = {bad};</script>', comparisonJob), /readable comparison data/);
        await rejects(() => comparisonAPI.comparisonPageURLs(pageHTML(comparisonData) + pageHTML(comparisonData), comparisonJob), /readable comparison data/);
        await rejects(() => comparisonAPI.comparisonPageURLs(pageHTML(comparisonData), { ...comparisonJob, collection: { key: 'different' } }), /does not match/);
        for (const change of [
            data => data.comparisons.pop(),
            data => { data.comparisons[1].name = '0001'; },
            data => data.comparisons[0].images.reverse(),
            data => data.comparisons[0].images.pop(),
            data => { data.comparisons[0].images[0].publicFileName = '../t/thumb.png'; },
            data => { data.comparisons[0].images[0].publicFileName = 'https://images.test/a.png'; },
            data => { data.comparisons[0].images[0].publicFileName = null; }
        ]) {
            const data = JSON.parse(JSON.stringify(comparisonData)); change(data);
            await rejects(() => comparisonAPI.comparisonPageURLs(pageHTML(data), comparisonJob), /match/);
        }
    });
    await test('completed slow.pics uploads expose Copy BBCode and fetch only on demand, then cache it', async () => {
        calls.length = 0;
        comparisonAPI.showArea({ root: null, names: ['GroupA', 'GroupB'], images: Array.from({ length: 4 }, (_, i) => ({
            source: `https://images.test/comp-${i}.png`, preview: `https://images.test/comp-${i}.png`
        })) });
        comparisonAPI.candidates.children[0].click();
        comparisonAPI.candidates.children[3].dispatchEvent(new MouseEvent('click', { shiftKey: true }));
        GM_cookie = { list(options, callback) { callback([{ name: 'XSRF-TOKEN', value: 'safe-token' }]); } };
        handler = options => {
            if (options.url.endsWith('/upload/comparison')) return { responseText: JSON.stringify({ collectionUuid: 'collection-id', key: 'first-row', images: [['a', 'b'], ['c', 'd']] }) };
            if (options.url.endsWith('/upload/image')) return { responseText: 'OK' };
            if (options.url === 'https://slow.pics/c/first-row') return { responseText: pageHTML(comparisonData) };
            return imageResponse();
        };
        await comparisonAPI.run('upload');
        const job = comparisonAPI.state.job;
        equal(job.done, 4);
        ok(!calls.some(call => call.url.includes('/c/')));
        const copy = [...comparisonAPI.result.querySelectorAll('button')].find(node => node.textContent === 'Copy BBCode');
        const output = comparisonAPI.result.querySelector('textarea');
        ok(copy && output.hidden);
        let copied;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
        const previous = calls.length;
        await copy.onclick();
        equal(calls.length, previous + 1);
        equal(calls.at(-1).url, 'https://slow.pics/c/first-row');
        equal(calls.at(-1).headers.Accept, 'text/html');
        equal(calls.at(-1).cookiePartition.topLevelSite, 'https://slow.pics');
        equal(calls.at(-1).anonymous, false);
        equal(copied, comparisonAPI.comparisonBBCode(job, expectedURLs));
        equal(output.value, copied);
        ok(!output.hidden && !copy.disabled);
        ok(!copied.includes('[img'));
        await comparisonAPI.copyComparisonBBCode(job, output, copy);
        equal(calls.length, previous + 1);
        ok(!comparisonAPI.diagnostics.join('').includes('first-a.png'));
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
        await comparisonAPI.copyComparisonBBCode(job, output, copy);
        ok(comparisonAPI.status.textContent.includes('Select and copy'));
        equal(output.value, copied);
    });
    await test('BBCode lookup failure, rate limiting and cancellation keep uploads complete and allow lookup-only retry', async () => {
        const job = comparisonAPI.state.job;
        const copy = [...comparisonAPI.result.querySelectorAll('button')].find(node => node.textContent === 'Copy BBCode');
        const output = comparisonAPI.result.querySelector('textarea');
        delete job.bbcode;
        calls.length = 0;
        handler = () => ({ status: 429, responseHeaders: 'Retry-After: 120' });
        await comparisonAPI.copyComparisonBBCode(job, output, copy);
        equal(job.done, 4);
        ok(comparisonAPI.uploadButton.disabled);
        ok(comparisonAPI.result.querySelector('a').href === 'https://slow.pics/c/first-row');
        ok(comparisonAPI.status.textContent.startsWith('Upload complete.'));
        await comparisonAPI.copyComparisonBBCode(job, output, copy);
        equal(calls.length, 1);
        comparisonAPI.retryAfter.clear();
        handler = () => ({ responseText: 'unreadable' });
        await comparisonAPI.copyComparisonBBCode(job, output, copy);
        equal(job.bbcode, undefined);
        let entered;
        const pending = new Promise(resolve => { entered = resolve; });
        handler = () => { entered(); return null; };
        const active = comparisonAPI.copyComparisonBBCode(job, output, copy);
        await pending;
        comparisonAPI.state.active.abort();
        await active;
        ok(comparisonAPI.status.textContent.includes('lookup cancelled'));
        ok(!copy.disabled);
        handler = () => ({ responseText: pageHTML(comparisonData) });
        await comparisonAPI.copyComparisonBBCode(job, output, copy);
        ok(job.bbcode.includes('[comparison=GroupA, GroupB]'));
        ok(calls.every(call => call.method === 'GET' && call.url === 'https://slow.pics/c/first-row'));
        comparisonAPI.resetButton.click();
        const count = calls.length;
        await comparisonAPI.copyComparisonBBCode(job, output, copy);
        equal(calls.length, count);
        equal(comparisonAPI.result.children.length, 0);
        comparisonAPI.close();
    });
    return results;
}

test('comparison behavior in Node DOM', { timeout: 60000 }, async t => {
    const examples = {};
    for (let i = 1; i <= 12; i++) {
        const path = join(__dirname, '..', 'tmp', 'comp-examples', `ex${i}.html`);
        if (existsSync(path)) examples[`ex${i}`] = readFileSync(path, 'utf8');
    }
    const pixhostPath = join(__dirname, '..', 'tmp', 'comp-examples', 'ex9_pixhost.html');
    const pixhostHTML = existsSync(pixhostPath) ? readFileSync(pixhostPath, 'utf8') : '';
    const results = await inDOM(`(${domTests.toString()})(${JSON.stringify(source)}, ${JSON.stringify(examples)}, ${JSON.stringify(pixhostHTML)})`);
    for (const result of results) {
        await t.test(result.name, () => assert.equal(result.ok, true, result.error));
    }
});
