// ==UserScript==
// @name         TwitchAdSolutions 日本語版 (strip) - 非推奨
// @namespace    https://github.com/ChihaluCoding/TwitchAdSolutions_Japanese
// @version      1.9
// @description  Multiple solutions for blocking Twitch ads (strip)
// @updateURL    https://github.com/ChihaluCoding/TwitchAdSolutions_Japanese/raw/main/strip/strip.user.js
// @downloadURL  https://github.com/ChihaluCoding/TwitchAdSolutions_Japanese/raw/main/strip/strip.user.js
// @author       pixeltris (original), ryanbr (fork)
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @inject-into  page
// @grant        none
// ==/UserScript==
(function() {
    'use strict';
    const ourTwitchAdSolutionsVersion = 26;// 古いバージョンのスクリプトとの競合を防ぐために使う
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log("別のスクリプトが有効なため除去処理をスキップします。こちらのバージョン:" + ourTwitchAdSolutionsVersion + " 有効なバージョン:" + window.twitchAdSolutionsVersion);
        window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    function declareOptions(scope) {
        scope.ReloadPlayerAfterAds = false;// 高遅延の場合には効果がないようである
        scope.ReloadPlayerDelay = 10000;
        scope.LastPlayerReload = 0;
        scope.ForceAccessTokenPlayerType = 'site';
        scope.DisableMatureConentPopup = false;// true にすると、年齢制限のあるコンテンツを視聴するのにログインが不要になる
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
        scope.NumStrippedSegments = 0;
        scope.M3U8Whitelist = new Set();
        scope.M3U8ChannelCache = new Map();
        scope.V2API = false;
    }
    const loggedCsaiTypes = new Set();
    let localStorageHookFailed = false;
    let adBlockDiv = null;
    const twitchWorkers = [];
    const workerStringConflicts = [
        'twitch',
        'isVariantA'// TwitchNoSub
    ];
    const workerStringAllow = [];
    const workerStringReinsert = [
        'isVariantA',// TwitchNoSub (prior to (0.9))
        'besuper/',// TwitchNoSub (0.9)
        '${patch_url}'// TwitchNoSub (0.9.1)
    ];
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x)) && !workerStringAllow.some((x) => workerString.includes(x))) {
                if (parent !== null) {
                    Object.setPrototypeOf(parent, Object.getPrototypeOf(proto));
                }
            } else {
                if (root === null) {
                    root = proto;
                }
                parent = proto;
            }
            proto = Object.getPrototypeOf(proto);
        }
        return root;
    }
    function getWorkersForReinsert(worker) {
        const result = [];
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringReinsert.some((x) => workerString.includes(x))) {
                result.push(proto);
            } else {
            }
            proto = Object.getPrototypeOf(proto);
        }
        return result;
    }
    function reinsertWorkers(worker, reinsert) {
        let parent = worker;
        for (let i = 0; i < reinsert.length; i++) {
            Object.setPrototypeOf(reinsert[i], parent);
            parent = reinsert[i];
        }
        return parent;
    }
    function isValidWorker(worker) {
        const workerString = worker.toString();
        return !workerStringConflicts.some((x) => workerString.includes(x))
            || workerStringAllow.some((x) => workerString.includes(x))
            || workerStringReinsert.some((x) => workerString.includes(x));
    }
    function hookWindowWorker() {
        const reinsert = getWorkersForReinsert(window.Worker);
        const newWorker = class Worker extends (getCleanWorker(window.Worker) || window.Worker) {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
                } catch {}
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    return;
                }
                // 事前チェック: 注入する前にワーカー JS を取得できるか確認する
                let prefetchedWorkerJs = null;
                try { prefetchedWorkerJs = getWasmWorkerJs(twitchBlobUrl); } catch {}
                if (!prefetchedWorkerJs) {
                    super(twitchBlobUrl, options);
                    console.log('[AD DEBUG] ワーカー JS の取得に失敗 — 未改変のワーカーにフォールバックします');
                    return;
                }
                const newBlobStr = `
                    ${stripAdSegments.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    const workerString = getWasmWorkerJs('${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
                    self.addEventListener('message', function(e) {
                        if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                            console.log('AllSegmentsAreAdSegments（全セグメントが広告）: ' + AllSegmentsAreAdSegments);
                        }
                    });
                    hookWorkerFetch();
                    eval(workerString);
                `;
                super(URL.createObjectURL(new Blob([newBlobStr])), options);
                twitchWorkers.length = 0;
                twitchWorkers.push(this);
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'ReloadPlayer') {
                        reloadTwitchPlayer();
                    } else if (e.data.key == 'UpdateAdBlockBannerStripping') {
                        if (adBlockDiv == null) {
                            adBlockDiv = getAdBlockDiv();
                        }
                        if (adBlockDiv != null) {
                            if (e.data.isStrippingAdSegments) {
                                adBlockDiv.P.textContent = 'Stripping' + (e.data.isMidroll ? ' midroll' : '') + ' ads' + (e.data.numStrippedAdSegments > 0 ? ` (${e.data.numStrippedAdSegments})` : '');
                                adBlockDiv.style.display = 'block';
                            } else {
                                adBlockDiv.style.display = 'none';
                            }
                        }
                    }
                });
                function getAdBlockDiv() {
                    // 広告をブロックしていることをユーザーに知らせるための表示。
                    const playerRootDiv = document.querySelector('.video-player');
                    let adBlockDiv = null;
                    if (playerRootDiv != null) {
                        adBlockDiv = playerRootDiv.querySelector('.tas-adblock-overlay');
                        if (adBlockDiv == null) {
                            adBlockDiv = document.createElement('div');
                            adBlockDiv.className = 'tas-adblock-overlay';
                            adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
                            adBlockDiv.style.display = 'none';
                            adBlockDiv.P = adBlockDiv.querySelector('p');
                            playerRootDiv.appendChild(adBlockDiv);
                        }
                    }
                    return adBlockDiv;
                }
            }
        };
        let workerInstance = reinsertWorkers(newWorker, reinsert);
        Object.defineProperty(window, 'Worker', {
            get: function() {
                return workerInstance;
            },
            set: function(value) {
                if (isValidWorker(value)) {
                    workerInstance = value;
                } else {
                    console.log('Twitch ワーカーの設定を拒否しました');
                }
            }
        });
    }
    function getWasmWorkerJs(twitchBlobUrl) {
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        return req.responseText;
    }
    function hookWorkerFetch() {
        console.log('hookWorkerFetch (strip)');
        const realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                if (AdSegmentCache.has(url)) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                resolve(await realFetch('data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA'));
                            } else {
                                resolve(response);
                            }
                        };
                        realFetch(url, options).then(function(response) {
                            processAfter(response);
                        })['catch'](function(err) {
                            reject(err);
                        });
                    });
                }
                if (M3U8Whitelist.has(url)) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                resolve(new Response(stripAdSegments(await response.text())));
                            } else {
                                resolve(response);
                            }
                        };
                        realFetch(url, options).then(function(response) {
                            processAfter(response);
                        })['catch'](function(err) {
                            reject(err);
                        });
                    });
                } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                const channelName = (new URL(url)).pathname.match(/([^\/]+)(?=\.\w+$)/)?.[0];
                                let encodingsM3u8 = await response.text();
                                const cachedM3u8 = M3U8ChannelCache.get(channelName);
                                if (cachedM3u8 && (await realFetch(cachedM3u8.match(/^https:.*\.m3u8$/m)?.[0])).status === 200) {
                                    encodingsM3u8 = replaceServerTimeInM3u8(cachedM3u8, getServerTimeFromM3u8(encodingsM3u8));
                                } else if (encodingsM3u8.includes('.m3u8')) {
                                    M3U8ChannelCache.set(channelName, encodingsM3u8);
                                }
                                const lines = encodingsM3u8.replaceAll('\r', '').split('\n');
                                for (let i = 0; i < lines.length - 1; i++) {
                                    if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1].includes('.m3u8')) {
                                        M3U8Whitelist.add(lines[i + 1]);
                                    }
                                }
                                resolve(new Response(encodingsM3u8));
                            } else {
                                resolve(response);
                            }
                        };
                        realFetch(url, options).then(function(response) {
                            processAfter(response);
                        })['catch'](function(err) {
                            reject(err);
                        });
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function getServerTimeFromM3u8(encodingsM3u8) {
        if (V2API) {
            const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
            return matches && matches.length > 1 ? matches[1] : null;
        }
        const matches = encodingsM3u8.match(/SERVER-TIME="([0-9.]+)"/);
        return matches && matches.length > 1 ? matches[1] : null;
    }
    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (V2API) {
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(/(SERVER-TIME=")[0-9.]+"/, `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
    }
    function stripAdSegments(textStr, stripAllSegments) {
        let hasStrippedAdSegments = false;
        let isMidroll = false;
        const lines = textStr.replaceAll('\r', '').split('\n');
        const newAdUrl = 'https://twitch.tv';
        let isLastSegmentLive = false;
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            // オーバーレイ UI に現れるトラッキング URL を除去する
            lines[i] = line
                .replaceAll(/(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g, `$1${newAdUrl}$2`);
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!line.includes(',live') || stripAllSegments || AllSegmentsAreAdSegments)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    NumStrippedSegments++;
                }
                AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            }
            if (line.startsWith('#EXTINF')) {
                isLastSegmentLive = line.includes(',live');
            }
            if (line.includes('stitched-ad')) {
                hasStrippedAdSegments = true;
                isLastSegmentLive = false;
            }
            if (line.includes('"MIDROLL"') || line.includes('"midroll"')) {
                isMidroll = true;
            }
        }
        if (isLastSegmentLive) {
            // 注意: プレイヤーの位置がバッファの位置より大きく遅れている場合、再生が始まる前にバナーが消えてしまう
            hasStrippedAdSegments = false;
        }
        if (hasStrippedAdSegments) {
            // 広告中は低遅延を無効化する（有効なままだとプレイヤーが広告セグメントを先読みして表示する可能性がある）
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    lines[i] = '';
                }
            }
        } else {
            if (NumStrippedSegments > 0 && ReloadPlayerAfterAds) {
                postMessage({key:'ReloadPlayer'});
            }
            NumStrippedSegments = 0;
        }
        AdSegmentCache.forEach((value, key, map) => {
            if (value < Date.now() - 120000) {
                map.delete(key);
            }
        });
        postMessage({
            key: 'UpdateAdBlockBannerStripping',
            isStrippingAdSegments: hasStrippedAdSegments,
            numStrippedAdSegments: NumStrippedSegments,
            isMidroll: isMidroll
        });
        return lines.join('\n');
    }
    function hookFetch() {
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = function(url, init, ...args) {
            if (typeof url === 'string') {
                if (url.includes('gql')) {
                    if (ForceAccessTokenPlayerType && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken') && !init.body.includes('picture-by-picture') && !init.body.includes('frontpage')) {
                        let replacedPlayerType = '';
                        const newBody = JSON.parse(init.body);
                        if (Array.isArray(newBody)) {
                            for (let i = 0; i < newBody.length; i++) {
                                if (newBody[i]?.variables?.playerType && newBody[i]?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                    replacedPlayerType = newBody[i].variables.playerType;
                                    newBody[i].variables.playerType = ForceAccessTokenPlayerType;
                                }
                            }
                        } else {
                            if (newBody?.variables?.playerType && newBody?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                replacedPlayerType = newBody.variables.playerType;
                                newBody.variables.playerType = ForceAccessTokenPlayerType;
                            }
                        }
                        if (replacedPlayerType) {
                            console.log(`プレイヤータイプ '${replacedPlayerType}' を '${ForceAccessTokenPlayerType}' に置き換えました`);
                            init.body = JSON.stringify(newBody);
                        }
                    }
                    if (DisableMatureConentPopup) {
                        const newBody2 = JSON.parse(init.body);
                        if (Array.isArray(newBody2)) {
                            let hasRemovedClassification = false;
                            for (let i = 0; i < newBody2.length; i++) {
                                if (newBody2[i]?.operationName == 'ContentClassificationContext') {
                                    hasRemovedClassification = true;
                                    // この要素を配列から削除するとうまくいかないようなので、代わりに別のエントリをこのインデックスに複製している。TODO: 理由を突き止める
                                    newBody2[i] = newBody2[i == 0 && newBody2.length > 1 ? 1 : 0];
                                }
                            }
                            if (hasRemovedClassification) {
                                init.body = JSON.stringify(newBody2);
                            }
                        }
                    }
                }
                if (url.includes('edge.ads.twitch.tv')) {
                    const csaiType = url.includes('bp=midroll') ? 'midroll' : url.includes('bp=preroll') ? 'preroll' : 'unknown';
                    if (!loggedCsaiTypes.has(csaiType)) {
                        loggedCsaiTypes.add(csaiType);
                        console.log('[AD DEBUG] CSAI の広告リクエストを検出 — 種別: ' + csaiType + '（クライアントサイド広告挿入。m3u8 ではブロックできません）');
                    }
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function reloadTwitchPlayer(isPausePlay) {
        // ttv-tools / ffz から引用
        // https://github.com/Nerixyz/ttv-tools/blob/master/src/context/twitch-player.ts
        // https://github.com/FrankerFaceZ/FrankerFaceZ/blob/master/src/sites/twitch-twilight/modules/player.jsx
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) {
                    return result;
                }
                node = node.sibling;
            }
            return null;
        }
        function findReactRootNode() {
            let reactRootNode = null;
            const rootNode = document.querySelector('#root');
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            console.log('React のルートが見つかりません');
            return;
        }
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        if (!player) {
            console.log('プレイヤーが見つかりません');
            return;
        }
        if (!playerState) {
            console.log('プレイヤーの状態が見つかりません');
            return;
        }
        if (player.paused || player.core?.paused) {
            return;
        }
        if (isPausePlay) {
            player.pause();
            player.play()?.catch?.(() => {});
            return;
        }
        if (document.pictureInPictureElement) {
            // PiP を維持するため一時停止 / 再生に切り替える。setSrc は PiP を終了させてしまう
            player.pause();
            player.play()?.catch?.(() => {});
            console.log('[AD DEBUG] PiP を維持するため、再読み込みを一時停止 / 再生に切り替えました');
            return;
        }
        if (LastPlayerReload > Date.now() - ReloadPlayerDelay) {
            return;
        }
        LastPlayerReload = Date.now();
        const lsKeyQuality = 'video-quality';
        const lsKeyMuted = 'video-muted';
        const lsKeyVolume = 'volume';
        let currentQualityLS = null;
        let currentMutedLS = null;
        let currentVolumeLS = null;
        try {
            currentQualityLS = localStorage.getItem(lsKeyQuality);
            currentMutedLS = localStorage.getItem(lsKeyMuted);
            currentVolumeLS = localStorage.getItem(lsKeyVolume);
            if (localStorageHookFailed && player?.core?.state) {
                localStorage.setItem(lsKeyMuted, JSON.stringify({default:player.core.state.muted}));
                localStorage.setItem(lsKeyVolume, player.core.state.volume);
            }
            if (localStorageHookFailed && player?.core?.state?.quality?.group) {
                localStorage.setItem(lsKeyQuality, JSON.stringify({default:player.core.state.quality.group}));
            }
        } catch {}
        console.log('Twitch のプレイヤーを再読み込みします');
        playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
        player.play()?.catch?.(() => {});
        if (localStorageHookFailed && (currentQualityLS || currentMutedLS || currentVolumeLS)) {
            setTimeout(() => {
                try {
                    if (currentQualityLS) {
                        localStorage.setItem(lsKeyQuality, currentQualityLS);
                    }
                    if (currentMutedLS) {
                        localStorage.setItem(lsKeyMuted, currentMutedLS);
                    }
                    if (currentVolumeLS) {
                        localStorage.setItem(lsKeyVolume, currentVolumeLS);
                    }
                } catch {}
            }, 3000);
        }
    }
    function onContentLoaded() {
        if (document.getElementById('seventv-extension')) {
            console.log('[AD DEBUG] 警告: 7TV 拡張機能を検出しました — 黒画面やバッファリングの原因になることがあります。問題が起きる場合は 7TV を無効にしてみてください。');
        }
        // 音量 / 解像度を保持するためのフック
        try {
            const keysToCache = [
                'video-quality',
                'video-muted',
                'volume',
                'lowLatencyModeEnabled',// 低遅延
                'persistenceEnabled',// ミニプレイヤー
            ];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = function(key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            };
            const realGetItem = localStorage.getItem;
            localStorage.getItem = function(key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            };
            if (!localStorage.getItem.toString().includes(Object.keys({cachedValues})[0])) {
                // これらのフックはプレイヤーの再読み込み時に状態を保持するのに役立つ
                // Firefox では localStorage の関数をフックできないが、Chrome ではできる
                localStorageHookFailed = true;
            }
        } catch (err) {
            console.log('localStorageHooks が失敗しました: ' + err)
            localStorageHookFailed = true;
        }
    }
    window.reloadTwitchPlayer = reloadTwitchPlayer;
    window.allSegmentsAreAdSegments = () => {
        postTwitchWorkerMessage('AllSegmentsAreAdSegments');
    };
    declareOptions(window);
    try {
        const lsPlayerType = localStorage.getItem('twitchAdSolutions_playerType');
        if (lsPlayerType !== null) {
            ForceAccessTokenPlayerType = lsPlayerType;
        }
    } catch {}
    console.log('[AD DEBUG] 設定: ForceAccessTokenPlayerType = ' + ForceAccessTokenPlayerType);
    hookWindowWorker();
    hookFetch();
    const realXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string' && url.includes('edge.ads.twitch.tv')) {
            const csaiType = url.includes('bp=midroll') ? 'midroll' : url.includes('bp=preroll') ? 'preroll' : 'unknown';
            const xhrKey = csaiType + '-xhr';
            if (!loggedCsaiTypes.has(xhrKey)) {
                loggedCsaiTypes.add(xhrKey);
                console.log('[AD DEBUG] CSAI の広告リクエスト（XHR）を検出 — 種別: ' + csaiType);
            }
        }
        return realXHROpen.apply(this, arguments);
    };
    if (document.readyState === "complete" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function() {
            onContentLoaded();
        });
    }
})();