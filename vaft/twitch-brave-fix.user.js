// ==UserScript==
// @name         TwitchAdSolutions 日本語版 (twitch-brave-fix)
// @namespace    https://github.com/ChihaluCoding/TwitchAdSolutions_Japanese
// @version      1.3.1
// @description  Bypass Brave fingerprint detection on Twitch GQL/integrity requests by retrying via GM_xmlHttpRequest with header spoofs (Sec-Ch-Ua brand rewrite from Brave to Google Chrome with synthetic fallback when userAgentData hidden, Sec-Ch-Ua-Platform, Sec-Ch-Ua-Mobile, Firefox User-Agent, explicit Origin/Referer/Host, Accept-Language). Also hides navigator.brave and rebrands navigator.userAgentData.brands / getHighEntropyValues from "Brave" to "Google Chrome" so Twitch JS can't preemptively flag the session. Per-request retry: each interceptable request goes native first, sniffs for `errors` in the response body, and retries that specific request via GM xhr if needed — fixes occasional fingerprint-driven failures (e.g. Brave login on www.twitch.tv) without paying the GM xhr tax on every successful request. Companion to vaft / video-swap-new. A uBlock Origin scriptlet variant (twitch-brave-fix-ublock-origin.js) is also available but covers JS-surface spoofs only — the GM xhr header-retry path is userscript-exclusive (Tampermonkey / Violentmonkey / Greasemonkey 4+).
// @updateURL    https://github.com/ChihaluCoding/TwitchAdSolutions_Japanese/raw/main/vaft/twitch-brave-fix.user.js
// @downloadURL  https://github.com/ChihaluCoding/TwitchAdSolutions_Japanese/raw/main/vaft/twitch-brave-fix.user.js
// @author       https://github.com/ryanbr/TwitchAdSolutions
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @grant        GM_xmlHttpRequest
// @grant        GM.xmlHttpRequest
// @connect      gql.twitch.tv
// @connect      passport.twitch.tv
// ==/UserScript==
(function() {
    let _isNested = false;
    try { _isNested = window.frameElement !== null; } catch (_e) { _isNested = true; }
    if (_isNested) {
        const _host = document.location.hostname;
        const _isEmbedContext = _host === 'player.twitch.tv' || _host === 'embed.twitch.tv' || document.location.pathname.startsWith('/embed/');
        if (!_isEmbedContext) return;
    }
    {
        const _clipHost = document.location.hostname;
        const _clipPath = document.location.pathname || '';
        if (_clipHost === 'clips.twitch.tv' || /^\/[^/]+\/clip\/[^/]+/.test(_clipPath)) return;
    }
    'use strict';
    const ourVersion = 5;
    console.log('[TwitchBraveFix] v1.3.1 を読み込んでいます');
    if (typeof window.twitchBraveFixVersion !== 'undefined' && window.twitchBraveFixVersion >= ourVersion) {
        console.log('[TwitchBraveFix] 競合: スキップしました — 別のインスタンスがすでに有効です（v' + window.twitchBraveFixVersion + '）');
        return;
    }
    window.twitchBraveFixVersion = ourVersion;

    // Twitch のバンドルが動く前に navigator.brave を隠し、navigator.brave.isBrave() によってセッションが
    // 先んじてフラグ付けされないようにする。Brave は Strict のシールド設定でもこのプロパティを公開するため、
    // 最も確実な Brave の検出手段である。標準的な isBrave のパターンは `undefined` に対してきれいに短絡する。
    try {
        if ('brave' in navigator) {
            Object.defineProperty(navigator, 'brave', {
                get: () => undefined,
                configurable: true,
            });
        }
    } catch (_e) { /* non-configurable on some Brave builds; accept the risk and rely on header spoofs */ }

    // navigator.userAgentData を書き換え、ページ内の JS が brands 配列を見たときに「Brave」ではなく
    // 「Google Chrome」と見えるようにする。Twitch は getHighEntropyValues(['brands']) を直接呼んで
    // セッションをフィンガープリントできるが、送信リクエストの Sec-Ch-Ua ヘッダーの偽装ではその
    // JS 側の面をカバーできない。Twitch のバンドルが読み込まれる前、document-start で同期的に実行される。
    try {
        const uaData = navigator.userAgentData;
        if (uaData) {
            const rebrand = (arr) => Array.isArray(arr)
                ? arr.map(b => b.brand === 'Brave'
                    ? { brand: 'Google Chrome', version: b.version }
                    : b)
                : arr;
            const spoofedBrands = Object.freeze(rebrand(uaData.brands));
            Object.defineProperty(uaData, 'brands', {
                get: () => spoofedBrands,
                configurable: true,
            });
            const origGHEV = uaData.getHighEntropyValues;
            if (typeof origGHEV === 'function') {
                uaData.getHighEntropyValues = function(hints) {
                    return origGHEV.call(this, hints).then(result => {
                        if (result && Array.isArray(result.brands))
                            result.brands = rebrand(result.brands);
                        if (result && Array.isArray(result.fullVersionList))
                            result.fullVersionList = rebrand(result.fullVersionList);
                        return result;
                    });
                };
            }
        }
    } catch (_e) { /* read-only on some builds — fall through to header-only spoof */ }

    const gmXhr = (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function') ? GM.xmlHttpRequest
                : (typeof GM_xmlHttpRequest === 'function') ? GM_xmlHttpRequest
                : null;
    if (!gmXhr) {
        console.log('[TwitchBraveFix] GM.xmlHttpRequest が利用できません — フォールバックを機能させるには Tampermonkey、Violentmonkey、または Greasemonkey 4 以降でインストールしてください。処理を中止します。');
        return;
    }

    const realFetch = window.fetch;

    function isInterceptable(url) {
        if (typeof url !== 'string') return false;
        return url.indexOf('gql.twitch.tv/gql') !== -1
            || url.indexOf('gql.twitch.tv/integrity') !== -1
            || url.indexOf('passport.twitch.tv/integrity') !== -1;
    }

    // 偽装に使う値は navigator.userAgent / navigator.userAgentData から導出され、セッション中に変化しない。
    // 初期化時に 1 回計算しておくことで、再試行ごとのヘッダー組み立てを単なるオブジェクトのコピーで済ませる。
    const SPOOF = (() => {
        const ua = navigator.userAgent;
        const chromeMatch = ua.match(/Chrome\/(\d+)/);
        const chromeMajor = chromeMatch && chromeMatch[1] ? parseInt(chromeMatch[1], 10) : 138;

        let platform;
        if (/Android/i.test(ua)) platform = '"Android"';
        else if (/iPhone|iPad|iPod/i.test(ua)) platform = '"iOS"';
        else if (/Windows/i.test(ua)) platform = '"Windows"';
        else if (/Mac OS X|Macintosh/i.test(ua)) platform = '"macOS"';
        else if (/Linux/i.test(ua)) platform = '"Linux"';
        else platform = '"Windows"';

        const mobile = /Mobile/.test(ua) ? '?1' : '?0';

        const platformMatch = ua.match(/\(([^)]+)\)/);
        const platformInner = platformMatch ? platformMatch[1] : 'Windows NT 10.0; Win64; x64';
        const firefoxVersion = chromeMajor + 2;
        const firefoxUA = 'Mozilla/5.0 (' + platformInner + '; rv:' + firefoxVersion
                        + '.0) Gecko/20100101 Firefox/' + firefoxVersion + '.0';

        // navigator.userAgentData が隠されている場合（Brave の Strict モード）や利用できない場合に使う、
        // 合成した Chrome-N の Sec-Ch-Ua。実際の Chromium が送る形式に合わせてあるため、「Brave」がないことが
        // 自然に見える。
        const syntheticSecChUa = '"Not_A Brand";v="99", "Google Chrome";v="' + chromeMajor
                               + '", "Chromium";v="' + chromeMajor + '"';

        return { chromeMajor, platform, mobile, firefoxUA, syntheticSecChUa };
    })();

    // キャッシュした Promise — getHighEntropyValues() は非同期だが結果は変化しないため、
    // 最初に必要になった時点で 1 回解決し、以降の再試行では同じ Promise を再利用する。
    let _secChUaPromise = null;
    function getSpoofedSecChUa() {
        if (_secChUaPromise) return _secChUaPromise;
        _secChUaPromise = (async () => {
            const uaData = navigator.userAgentData;
            if (uaData && typeof uaData.getHighEntropyValues === 'function') {
                try {
                    const { brands } = await uaData.getHighEntropyValues(['brands']);
                    if (brands && brands.length) {
                        return brands.map(b => {
                            const brand = b.brand === 'Brave' ? 'Google Chrome' : b.brand;
                            return '"' + brand + '";v="' + b.version + '"';
                        }).join(', ');
                    }
                } catch (_e) { /* fall through to synthetic */ }
            }
            return SPOOF.syntheticSecChUa;
        })();
        return _secChUaPromise;
    }

    function parseRawHeaders(headersStr) {
        const headers = new Headers();
        if (!headersStr) return headers;
        const lines = headersStr.trim().split(/[\r\n]+/);
        for (const line of lines) {
            const idx = line.indexOf(':');
            if (idx < 0) continue;
            const name = line.slice(0, idx).trim();
            const value = line.slice(idx + 1).trim();
            if (name) {
                try { headers.append(name, value); } catch (_e) { /* skip illegal header names from set-cookie etc. */ }
            }
        }
        return headers;
    }

    function gmRespToFetchResp(gmResp) {
        return new Response(gmResp.responseText || '', {
            status: gmResp.status || 0,
            statusText: gmResp.statusText || '',
            headers: parseRawHeaders(gmResp.responseHeaders),
        });
    }

    async function readBodyAsText(input, init) {
        if (init && typeof init.body === 'string') return init.body;
        if (init && init.body && typeof init.body.text === 'function') {
            try { return await init.body.text(); } catch (_e) { return undefined; }
        }
        if (input instanceof Request) {
            try { return await input.clone().text(); } catch (_e) { return undefined; }
        }
        return undefined;
    }

    function collectHeaders(input, init) {
        const out = {};
        if (input instanceof Request && input.headers) {
            input.headers.forEach((v, k) => { out[k] = v; });
        }
        if (init && init.headers) {
            if (init.headers instanceof Headers) {
                init.headers.forEach((v, k) => { out[k] = v; });
            } else if (Array.isArray(init.headers)) {
                for (const [k, v] of init.headers) out[k] = v;
            } else {
                for (const k of Object.keys(init.headers)) out[k] = init.headers[k];
            }
        }
        return out;
    }

    async function gmRetry(url, method, bodyText, baseHeaders) {
        const spoofedSecChUa = await getSpoofedSecChUa();
        const headers = Object.assign({}, baseHeaders || {});
        if (spoofedSecChUa) headers['Sec-Ch-Ua'] = spoofedSecChUa;
        headers['Sec-Ch-Ua-Mobile'] = SPOOF.mobile;
        headers['Sec-Ch-Ua-Platform'] = SPOOF.platform;
        headers['User-Agent'] = SPOOF.firefoxUA;
        headers['Accept-Language'] = 'en-US,en;q=0.9';
        headers['Referer'] = 'https://www.twitch.tv/';
        headers['Origin'] = 'https://www.twitch.tv/';
        headers['Host'] = 'gql.twitch.tv';
        return new Promise((resolve, reject) => {
            gmXhr({
                method: method || 'GET',
                url: url,
                data: bodyText,
                headers: headers,
                onload: resp => resolve(resp),
                onerror: err => reject(err),
                ontimeout: () => reject(new Error('TwitchBraveFix: GM_xmlHttpRequest timeout')),
            });
        });
    }

    async function maybeRetryOnErrors(url, method, headers, response, readBody) {
        if (response.status !== 200) return response;
        const cloned = response.clone();
        let bodyTextResp;
        try { bodyTextResp = await cloned.text(); } catch (_e) { return response; }
        let parsed;
        try { parsed = JSON.parse(bodyTextResp); } catch (_e) { return response; }
        // Twitch 側の手がかり: HTTP 200 でありながらトップレベルに `errors` フィールドがある場合、
        // フィンガープリントの検証に失敗したことを意味する。正規の GQL のレスポンスは `data` か
        // `data` 形状のオブジェクトの配列であり、`errors` はゲートウェイの段階で拒否されたときにしか現れない。
        if (typeof parsed?.errors === 'undefined' && !(Array.isArray(parsed) && parsed.some(p => typeof p?.errors !== 'undefined'))) {
            return response;
        }
        console.log('[TwitchBraveFix] ' + url.replace(/\?.*$/, '') + ' で GQL のエラーを検出しました — ヘッダーを偽装して GM_xmlHttpRequest で再試行します');
        // ボディが必要なのは再試行の経路だけなので、クローンとデコードはここまで遅らせる。
        // これにより、正常系では横取り対象のリクエストごとにそのコストを払わずに済む。
        const bodyText = await readBody();
        try {
            const gmResp = await gmRetry(url, method, bodyText, headers);
            return gmRespToFetchResp(gmResp);
        } catch (e) {
            console.log('[TwitchBraveFix] GM_xmlHttpRequest による再試行に失敗しました。元のエラーのレスポンスを返します:', (e && e.message) || e);
            return new Response(bodyTextResp, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        }
    }

    // 外側のラッパーを同期にすることで、約 99% を占める横取り対象外のホットパスが、async 関数による
    // Promise の包み込みと、インライン化を妨げる `arguments` へのアクセスを回避できる。try/catch は、
    // 先に `.then()` を挟まずに `.catch()` を使う呼び出し元のために、
    // 「fetch は同期的に例外を投げず、常に Promise を返す」という契約を保つ。
    async function _interceptedFetch(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = (init && init.method) || (input && input.method) || 'GET';
        const headers = collectHeaders(input, init);
        // ボディは遅延して取得する。Request を入力とする場合は、元のものが realFetch に消費されるため
        // 取得前のクローンを保持しておくが、デコードするのは実際に再試行が発動したときだけである。
        const bodyClone = (input instanceof Request) ? input.clone() : null;
        const readBody = () => readBodyAsText(bodyClone || input, init);
        const response = await realFetch.call(this, input, init);
        return maybeRetryOnErrors(url, method, headers, response, readBody);
    }

    window.fetch = function _braveFixFetch(input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (!isInterceptable(url)) {
                return realFetch.call(this, input, init);
            }
            return _interceptedFetch.call(this, input, init);
        } catch (e) {
            return Promise.reject(e);
        }
    };

    console.log('[TwitchBraveFix] window.fetch のフックを設定し、navigator.brave を隠し、userAgentData を書き換えました — リクエストごとの再試行: まずネイティブの fetch を行い、レスポンスに `errors` が含まれる場合のみ GM_xmlHttpRequest で再試行します');
})();
