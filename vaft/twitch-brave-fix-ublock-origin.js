twitch-brave-fix.js text/javascript
// TwitchAdSolutions (twitch-brave-fix) — vaft/twitch-brave-fix.user.js の uBlock Origin スクリプトレット版
// JS 側の Brave のフィンガープリント対策のみを扱う。ユーザースクリプト版はこれに加えて、失敗した
// リクエストを GM_xmlHttpRequest でヘッダーを偽装して再試行する（Sec-Ch-Ua、User-Agent など）。
// その経路は uBO のスクリプトレットでは動作しない。GM.xmlHttpRequest はユーザースクリプト
// マネージャーの API であり、ページ側の fetch / XHR から禁止されたリクエストヘッダーを設定しようとしても
// ブラウザが黙って無視するためである。
// このスクリプトレットだけでは Brave で Twitch のログインが失敗する場合は、.user.js 版をインストールすること。
(function() {
    if (/(^|\.)twitch\.tv$/.test(document.location.hostname) === false) return;
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
    console.log('[TwitchBraveFix-uBO] v1.3.1 を読み込んでいます');
    // .user.js 版と共有するバージョンのフラグ。バージョンが高い方が有効になるため、
    // 両方を入れているユーザーでもフックが重複せず、有効なインスタンスは 1 つになる。
    if (typeof window.twitchBraveFixVersion !== 'undefined' && window.twitchBraveFixVersion >= ourVersion) {
        console.log('[TwitchBraveFix-uBO] 競合: スキップしました — 別のインスタンスがすでに有効です（v' + window.twitchBraveFixVersion + '）');
        return;
    }
    window.twitchBraveFixVersion = ourVersion;

    // Twitch のバンドルが動く前に navigator.brave を隠し、navigator.brave.isBrave() によって
    // セッションが先んじてフラグ付けされないようにする。Brave は Strict のシールド設定でも
    // このプロパティを公開するため、最も確実な Brave の検出手段である。標準的な isBrave の
    // パターンは `undefined` に対してきれいに短絡する。
    try {
        if ('brave' in navigator) {
            Object.defineProperty(navigator, 'brave', {
                get: () => undefined,
                configurable: true,
            });
        }
    } catch (_e) { /* non-configurable on some Brave builds; accept the risk */ }

    // navigator.userAgentData を書き換え、ページ内の JS が brands 配列を見たときに「Brave」ではなく
    // 「Google Chrome」と見えるようにする。Twitch は getHighEntropyValues(['brands']) を直接呼んで
    // セッションをフィンガープリントできるため、同期の `brands` ゲッターと非同期の getHighEntropyValues の
    // 結果の両方を上書きする（`brands` と `fullVersionList` の両方を書き換える）。注入時に同期的に実行される。
    // uBO のスクリプトレットは document-start で注入されるため、Twitch のバンドルより先に適用される。
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
    } catch (_e) { /* read-only on some builds — fall through */ }

    // 診断用の fetch フック。ここに復旧の手段はなく、Twitch のゲートウェイが横取り対象の
    // リクエストをトップレベルの `errors` フィールドで拒否したときに、コンソールに 1 行出すだけである。
    // JS 側の偽装だけではこのセッションには不十分で、ユーザースクリプト版（GM xhr による
    // ヘッダー付き再試行を持つもの）が必要であることをユーザーに伝える。ログの氾濫を避けるため、
    // ページの読み込みごとに 1 回だけ出力する。
    const realFetch = window.fetch;

    function isInterceptable(url) {
        if (typeof url !== 'string') return false;
        return url.indexOf('gql.twitch.tv/gql') !== -1
            || url.indexOf('gql.twitch.tv/integrity') !== -1
            || url.indexOf('passport.twitch.tv/integrity') !== -1;
    }

    let _errorReported = false;
    async function _checkForErrors(url, response) {
        if (_errorReported || response.status !== 200) return response;
        const cloned = response.clone();
        let bodyText;
        try { bodyText = await cloned.text(); } catch (_e) { return response; }
        let parsed;
        try { parsed = JSON.parse(bodyText); } catch (_e) { return response; }
        const hasErrors = typeof parsed?.errors !== 'undefined'
            || (Array.isArray(parsed) && parsed.some(p => typeof p?.errors !== 'undefined'));
        if (hasErrors) {
            _errorReported = true;
            console.log('[TwitchBraveFix-uBO] DETECTED GQL errors on ' + url.replace(/\?.*$/, '')
                + ' — JS-surface spoofs were insufficient for this session. The .user.js variant '
                + 'retries via GM_xmlHttpRequest with full header spoofs; install it if Twitch '
                + 'login or playback fails persistently.');
        }
        return response;
    }

    window.fetch = function _braveFixFetchUbo(input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (!isInterceptable(url)) return realFetch.call(this, input, init);
            return realFetch.call(this, input, init).then(resp => _checkForErrors(url, resp));
        } catch (e) {
            return Promise.reject(e);
        }
    };

    console.log('[TwitchBraveFix-uBO] navigator.brave を隠し、userAgentData を書き換え、診断用の fetch フックを設定しました');
})();
