// ==UserScript==
// @name         TwitchAdSolutions (video-swap-new)
// @namespace    https://github.com/ryanbr/TwitchAdSolutions
// @version      1.86
// @updateURL    https://github.com/ryanbr/TwitchAdSolutions/raw/master/video-swap-new/video-swap-new.user.js
// @downloadURL  https://github.com/ryanbr/TwitchAdSolutions/raw/master/video-swap-new/video-swap-new.user.js
// @description  Multiple solutions for blocking Twitch ads (video-swap-new)
// @author       pixeltris (original), ryanbr (fork)
// @match        *://*.twitch.tv/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function() {
    // 正規の Twitch 埋め込みコンテキストではない入れ子のフレームには注入しない。
    // Twitch のチャンネルページには 5 つ以上の非表示のクロスオリジン iframe（認証、解析、広告 SDK など）があり、
    // ユーザースクリプトマネージャーや uBO は条件に一致するすべてに注入する。その一つひとつが競合する
    // インスタンスになり、プレイヤーの制御を奪い合ってしまう。twitch.tv/CHANNEL でプレイヤーを持つのは
    // 最上位フレームだけで、入れ子の補助フレームはノイズである。
    // 入れ子フレームへの注入を許可するリスト: Twitch が文書化している 3 つの埋め込みコンテキスト
    // （https://dev.twitch.tv/docs/embed/video-and-clips/）。これにより、親が別オリジンの iframe 内で
    // スクリプトが動作するサードパーティサイト上の Twitch 配信の埋め込みが維持される。
    // 入れ子フレームの判定には window.frameElement を使う。最上位フレームでは null、同一オリジンの
    // 入れ子フレームでは iframe 要素を返し、クロスオリジンの入れ子フレームでは例外を投げる。
    // 'window !== window.top' より確実である。Tampermonkey は window をプロキシで包むため、
    // 最上位フレームでも厳密比較が true になることがあるからである。
    let _isNested = false;
    try { _isNested = window.frameElement !== null; } catch (_e) { _isNested = true; }
    if (_isNested) {
        const _host = document.location.hostname;
        const _isEmbedContext = _host === 'player.twitch.tv' || _host === 'embed.twitch.tv' || document.location.pathname.startsWith('/embed/');
        if (!_isEmbedContext) {
            console.log('[AD DEBUG] video-swap-new をスキップしました — ' + _host + document.location.pathname + ' の入れ子フレームです（Twitch の埋め込みではありません）。twitch.tv/CHANNEL の最上位フレームでこれが表示される場合は報告してください。');
            return;
        }
    }
    // Twitch のクリップエディタ（clips.twitch.tv ホスト、または /<channel>/clip/<slug> のパス）では注入をスキップする。
    // fetch / Worker のフックとバッファ監視はライブチャンネルのプレイヤーを対象としたもので、
    // クリップエディタのシーク可能なプレビューには対象となる広告がなく、ユーザーがトリム範囲を
    // ドラッグした際にプレビューがフリーズする原因になっていた。（TTV-AB v6.4.9 と同期。）
    {
        const _clipHost = document.location.hostname;
        const _clipPath = document.location.pathname || '';
        if (_clipHost === 'clips.twitch.tv' || /^\/[^/]+\/clip\/[^/]+/.test(_clipPath)) {
            console.log('[AD DEBUG] video-swap-new をスキップしました — クリップエディタのページです（' + _clipHost + _clipPath + '）。');
            return;
        }
    }
    'use strict';
    const ourTwitchAdSolutionsVersion = 54;// 古いバージョンのスクリプトとの競合を防ぐために使う
    console.log('[AD DEBUG] TwitchAdSolutions video-swap-new v' + ourTwitchAdSolutionsVersion + ' を読み込んでいます');
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log('[AD DEBUG] 競合: video-swap-new v' + ourTwitchAdSolutionsVersion + ' をスキップしました — 別のスクリプトがすでに有効です（v' + window.twitchAdSolutionsVersion + '）。重複するスクリプトを削除してください。');
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    function declareOptions(scope) {
        // オプション / グローバル
        // 'embed' は末尾に移動した。twitch.tv オリジンから embed の streamPlaybackAccessToken を要求すると
        // Twitch が GQL の 'server error' を返すことが実地で確認されているため。
        scope.OPT_BACKUP_PLAYER_TYPES = [ 'popout', 'mobile_web', 'embed' ];
        scope.OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE = 'popout';
        // 'twitch-stitched' は twitch-stitched-* の DATERANGE クラス群（-ad、-mid、-pod など）を、
        // 正確な -ad 接尾辞を要求せずに捕捉する。twitch- の接頭辞を付けることで、
        // 素の 'stitched' の部分一致による PR #120 の誤検出を再発させない。
        scope.AD_SIGNIFIERS = ['stitched-ad', 'EXT-X-CUE-OUT', 'twitch-stitched', 'EXT-X-DATERANGE:CLASS="twitch-maf-ad"', 'EXT-X-DATERANGE:CLASS="twitch-trigger"'];
        // セッション / ソースのメタデータであることが確認済みで広告マーカーではない。候補のログから除外する。
        scope.KNOWN_NON_AD_SIGNIFIERS = ['twitch-session', 'twitch-stream-source', 'twitch-ad-quartile', 'twitch-assignment'];
        scope.AD_SEGMENT_URL_PATTERNS = ['/adsquared/', '/_404/', '/processing'];
        // stripAdSegments のホットパスで共有するコンパイル済みの正規表現。ここで宣言し
        // （declareOptions によってワーカーの blob にシリアライズされる）、行ごとの除去ループ内の
        // リテラルが毎回再コンパイルされないようにする。
        scope.TWITCH_AD_URL_REWRITE_REGEX = /(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g;
        scope.URI_ATTRIBUTE_REGEX = /URI="([^"]+)"/;
        scope.LIVE_SIGNIFIER = ',live';
        scope.CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        // これらは実質的にワーカースコープ専用である...
        scope.StreamInfos = Object.create(null);
        scope.StreamInfosByUrl = Object.create(null);
        // これは両方のスコープで必要になる。window スコープからワーカースコープへ更新する必要がある。
        scope.gql_device_id = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
        scope.ReloadPlayerAfterAd = true;// 広告の終了後、一時停止 / 再生ではなくプレイヤーの再読み込みを行う
        scope.ReloadCooldownSeconds = 30;// 再読み込みの最小間隔（秒）— 再読み込みが引き金となる CSAI の連鎖を断ち切る
        scope.EarlyReloadPollThreshold = 5;// 早期再読み込みまでの全セグメント除去のポーリング回数（1 回あたり約 2 秒なので 5 で約 10 秒。0 で無効）
        scope.PinBackupPlayerType = false;// true にすると、成功したバックアップのプレイヤータイプを記憶し、次回の広告で最初に試す
        scope.StreamInfoMaxAgeMs = 30 * 60 * 1000;
    }
    function createStreamInfo(channelName, usherParams) {
        return {
            ChannelName: channelName,
            LastSeenAt: Date.now(),
            UsherParams: usherParams,
            Urls: new Map(),
            RequestedAds: new Set(),
            Encodings: null,
            BackupEncodings: null,
            BackupEncodingsStatus: new Map(),
            BackupEncodingsPlayerTypeIndex: -1,
            PinnedBackupPlayerType: null,
            HasCheckedUnknownTags: false,
            HasConfirmedAdAttrs: false,
            HasLoggedAdAttributes: false,
            HasLoggedUnknownSignifiers: false,
            IsMovingOffBackupEncodings: false,
            IsMidroll: false,
            IsStrippingAdSegments: false,
            NumStrippedAdSegments: 0,
            RecoverySegments: [],
            RecoveryStartSeq: undefined,
            CleanPlaylistCount: 0,
            PendingAdEndAt: 0,// 今回の広告でバックアップのポーリングが最初にクリーンになった時刻 — 揺れに強い最大待機の判定を制御する（TTV-AB v6.6.7 の #1 / #4）
            AdEndBounceCount: 0,// PendingAdEndAt が有効な間に広告マーカーが揺れた回数 — 計測用のみ
            ConsecutiveZeroStripBreaks: 0,
            UseFallbackStream: false,
            LastCleanNativeM3U8: null,
            LastCleanNativePlaylistAt: 0,
            // 早期再読み込み + クールダウン
            ConsecutiveAllStrippedPolls: 0,
            EarlyReloadTriggered: false,
            LastPlayerReload: 0,
            ReloadTimestamps: [],
            // 検出の診断
            LoggedOfflineTransition: false,
            ConsecutiveTokenFetchFailures: 0,
            LoggedTokenFailureStreak: false,
        };
    }
    function maskAsNative(fn, name) {
        fn.toString = () => 'function ' + name + '() { [native code] }';
        return fn;
    }
    function pruneStreamInfos() {
        const now = Date.now();
        for (const channelName in StreamInfos) {
            const streamInfo = StreamInfos[channelName];
            if (!streamInfo || !streamInfo.LastSeenAt || (now - streamInfo.LastSeenAt) > StreamInfoMaxAgeMs) {
                if (streamInfo && streamInfo.Urls) {
                    streamInfo.Urls.forEach((_, url) => { delete StreamInfosByUrl[url]; });
                }
                delete StreamInfos[channelName];
            }
        }
    }
    const loggedCsaiTypes = new Set();
    let twitchPlayerAndState = null;
    let localStorageHookFailed = false;
    let lastReloadTimestamp = 0;
    let reloadTimestamps = [];
    let EscalatedFromCooldown = null;// 延長前の値を保持し、集中して発生した状態が収まったら戻せるようにする
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
                    // 他の拡張機能が Worker.prototype を凍結している可能性があるため、リンクごとに try-catch する。
                    try { Object.setPrototypeOf(parent, Object.getPrototypeOf(proto)); } catch {}
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
            // リンクごとの try-catch: 他の拡張機能に凍結されたエントリがあってもチェーン全体を中断させない。
            try { Object.setPrototypeOf(reinsert[i], parent); } catch {}
            parent = reinsert[i];
        }
        return parent;
    }
    function isValidWorker(worker) {
        const workerString = worker.toString();
        const hasConflict = workerStringConflicts.some((x) => workerString.includes(x));
        const hasAllow = workerStringAllow.some((x) => workerString.includes(x));
        const hasReinsert = workerStringReinsert.some((x) => workerString.includes(x));
        if (hasConflict && !hasAllow && !hasReinsert) {
            console.log('[AD DEBUG] ワーカーを拒否しました — 競合する文字列を検出: ' + workerStringConflicts.filter((x) => workerString.includes(x)).join(', '));
        }
        return !hasConflict || hasAllow || hasReinsert;
    }
    let injectedBlobUrl = null;
    let originalRevokeObjectURL = null;
    function hookWindowWorker() {
        // 注入したワーカーの blob URL が Twitch によって revoke されるのを防ぐ
        if (!URL.revokeObjectURL.__tasMasked) {
            originalRevokeObjectURL = URL.revokeObjectURL;
            URL.revokeObjectURL = maskAsNative(function(url) {
                if (url === injectedBlobUrl) return;
                return originalRevokeObjectURL.call(this, url);
            }, 'revokeObjectURL');
            URL.revokeObjectURL.__tasMasked = true;
        }
        const reinsert = getWorkersForReinsert(window.Worker);
        const newWorker = class Worker extends (getCleanWorker(window.Worker) || window.Worker) {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = new URL(twitchBlobUrl).origin.endsWith('.twitch.tv');
                } catch {}
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    console.log('[AD DEBUG] Twitch 以外のワーカーをスキップしました: ' + twitchBlobUrl);
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
                console.log('[AD DEBUG] ワーカーを横取りしました — 広告ブロックのフックを注入します');
                const newBlobStr = `
                    const pendingFetchRequests = new Map();
                    ${hasAdTags.toString()}
                    ${getMatchedAdSignifiers.toString()}
                    ${stripAdSegments.toString()}
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getAccessToken.toString()}
                    ${gqlRequest.toString()}
                    ${parseAttributes.toString()}
                    ${setStreamInfoUrls.toString()}
                    ${onFoundAd.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    ${getStreamUrlForResolution.toString()}
                    ${updateAdblockBannerForStream.toString()}
                    ${pruneStreamInfos.toString()}
                    ${createStreamInfo.toString()}
                    const workerString = getWasmWorkerJs('${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
                    if (!self.__tasPruneInterval) {
                        self.__tasPruneInterval = setInterval(pruneStreamInfos, 5 * 60 * 1000);
                    }
                    ReloadPlayerAfterAd = ${ReloadPlayerAfterAd};
                    ReloadCooldownSeconds = ${ReloadCooldownSeconds};
                    EarlyReloadPollThreshold = ${EarlyReloadPollThreshold};
                    PinBackupPlayerType = ${PinBackupPlayerType};
                    OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE = '${OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE}';
                    gql_device_id = ${gql_device_id ? "'" + gql_device_id + "'" : null};
                    AuthorizationHeader = ${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = ${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    self.addEventListener('message', function(e) {
                        if (e.data.key == 'UboUpdateDeviceId') {
                            gql_device_id = e.data.value;
                        } else if (e.data.key == 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key == 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key == 'FetchResponse') {
                            const responseData = e.data.value;
                            if (pendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject, timeoutId } = pendingFetchRequests.get(responseData.id);
                                clearTimeout(timeoutId);
                                pendingFetchRequests.delete(responseData.id);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    // レスポンスデータから Response オブジェクトを生成する。
                                    // Response のコンストラクタは status / statusText / headers しか受け取らないため、url / redirected / type は
                                    // インスタンス側で定義する必要がある。IVS の WASM はこれらを検証しており（Spade / トラッキングの
                                    // リクエスト）、欠けていると NetworkError を投げる。TTV-AB v6.3.5 の修正。
                                    const response = new Response(responseData.body, {
                                        status: responseData.status,
                                        statusText: responseData.statusText,
                                        headers: responseData.headers
                                    });
                                    try {
                                        Object.defineProperty(response, 'url', { value: responseData.url || '', configurable: true });
                                        Object.defineProperty(response, 'redirected', { value: !!responseData.redirected, configurable: true });
                                        Object.defineProperty(response, 'type', { value: responseData.type || 'basic', configurable: true });
                                    } catch {}
                                    resolve(response);
                                }
                            }
                        } else if (e.data.key == 'SimulateAds') {
                            SimulatedAdsDepth = e.data.value;
                            console.log('SimulatedAdsDepth（模擬広告の深さ）: ' + SimulatedAdsDepth);
                        } else if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                            console.log('AllSegmentsAreAdSegments（全セグメントが広告）: ' + AllSegmentsAreAdSegments);
                        }
                    });
                    hookWorkerFetch();
                    // eval をガードする。不正な workerString によって、診断情報も出さずに
                    // Twitch のプレイヤーロジックが壊れることがないようにする。
                    try { eval(workerString); } catch (e) { console.error('[AD DEBUG] ワーカーの eval に失敗 — Twitch のプレイヤーロジックが読み込まれていません:', e); }
                `
                if (injectedBlobUrl && originalRevokeObjectURL) {
                    try { originalRevokeObjectURL.call(URL, injectedBlobUrl); } catch {}
                }
                injectedBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
                super(injectedBlobUrl, options);
                twitchWorkers.length = 0;
                twitchWorkers.push(this);
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'UboUpdateAdBanner') {
                        updateAdblockBanner(e.data);
                    } else if (e.data.key == 'UboReloadPlayer') {
                        reloadTwitchPlayer(false, e.data.kind);
                    } else if (e.data.key == 'UboPauseResumePlayer') {
                        reloadTwitchPlayer(true);
                    }
                });
                this.addEventListener('message', async event => {
                    if (event.data.key == 'FetchRequest') {
                        const fetchRequest = event.data.value;
                        const responseData = await handleWorkerFetchRequest(fetchRequest);
                        this.postMessage({
                            key: 'FetchResponse',
                            value: responseData
                        });
                    }
                });
                // ワーカーのクラッシュからの復旧 — IVS の WASM ワーカーは RuntimeError
                // （"index out of bounds" など）を投げて停止することがある。1 回のクラッシュで
                // 複数の error イベントが発生するため、ローカルのフラグで重複を排除する。最初のエラーで
                // プレイヤーの再読み込みを発動する。Twitch は新しいプレイヤーインスタンスの一部として
                // ワーカーを再生成し、既存の再読み込みクールダウンが再起動のループを防ぐ。
                let crashed = false;
                this.addEventListener('error', (e) => {
                    if (crashed) return;
                    crashed = true;
                    console.log('[AD DEBUG] IVS の WASM ワーカーがクラッシュしました: ' + ((e && e.message) || '不明なエラー') + ' — 復旧のためプレイヤーを再読み込みします');
                    try { reloadTwitchPlayer(false); } catch (err) {
                        console.log('[AD DEBUG] ワーカーのクラッシュからの復旧に失敗しました: ' + err.message);
                    }
                });
            }
        }
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
        if (!getWasmWorkerJs.cache) {
            getWasmWorkerJs.cache = Object.create(null);
        }
        if (getWasmWorkerJs.cache[twitchBlobUrl]) {
            return getWasmWorkerJs.cache[twitchBlobUrl];
        }
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        const text = req.responseText;
        getWasmWorkerJs.cache[twitchBlobUrl] = text;
        return text;
    }
    function setStreamInfoUrls(streamInfo, encodingsM3u8) {
        const lines = encodingsM3u8.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            // v2 API のバリアント URL は、パスに '.m3u8' を含まない生の CDN URL である。
            // '.m3u8' の URL に加えて、絶対 URL（'://' を含むもの）も受け入れる。
            const trimmed = lines[i]?.trim();
            if (trimmed && !trimmed.startsWith('#') && (trimmed.includes('.m3u8') || trimmed.includes('://'))) {
                StreamInfosByUrl[lines[i].trimEnd()] = streamInfo;
            }
            const nextLine = lines[i + 1]?.trim();
            if (lines[i].startsWith('#EXT-X-STREAM-INF') && nextLine && !nextLine.startsWith('#') && (nextLine.includes('.m3u8') || nextLine.includes('://'))) {
                const attributes = parseAttributes(lines[i]);
                const resolution = attributes['RESOLUTION'];
                if (resolution) {
                    const resolutionInfo = {
                        Resolution: resolution,
                        FrameRate: attributes['FRAME-RATE'],
                        Url: lines[i + 1]
                    };
                    streamInfo.Urls.set(lines[i + 1].trimEnd(), resolutionInfo);
                }
            }
        }
    }
    function updateAdblockBannerForStream(streamInfo) {
        const isShowingAd = !!streamInfo.BackupEncodings;
        if (!isShowingAd && (streamInfo.IsStrippingAdSegments || streamInfo.NumStrippedAdSegments > 0)) {
            streamInfo.IsStrippingAdSegments = false;
            streamInfo.NumStrippedAdSegments = 0;
        }
        postMessage({
            key: 'UboUpdateAdBanner',
            isMidroll: streamInfo.IsMidroll,
            hasAds: isShowingAd,
            isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
            numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
            activeBackupPlayerType: streamInfo.BackupEncodingsPlayerTypeIndex >= 0 ? OPT_BACKUP_PLAYER_TYPES[streamInfo.BackupEncodingsPlayerTypeIndex] : null
        });
    }
    async function onFoundAd(streamInfo, textStr, reloadPlayer, realFetch, url, resolutionInfo) {
        let result = textStr;
        streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
        // 信頼度の高い広告マーカーを追跡し、本物の広告とシグニファイアの誤検出を区別する。
        // これらの属性は本物の Twitch の広告には必ず存在し、誤検出を起こしうるもの
        // （'stitched' という語を含むメタデータなど）には存在しない。
        if (!streamInfo.HasConfirmedAdAttrs) {
            streamInfo.HasConfirmedAdAttrs = textStr.includes('X-TV-TWITCH-AD-AD-SESSION-ID') || textStr.includes('X-TV-TWITCH-AD-RADS-TOKEN');
        }
        const playerTypes = [...OPT_BACKUP_PLAYER_TYPES];
        // 利用可能であれば、固定されたバックアップのプレイヤータイプを最初に試す
        if (PinBackupPlayerType && streamInfo.PinnedBackupPlayerType) {
            const pinnedIndex = playerTypes.indexOf(streamInfo.PinnedBackupPlayerType);
            if (pinnedIndex > 0) {
                playerTypes.splice(pinnedIndex, 1);
                playerTypes.unshift(streamInfo.PinnedBackupPlayerType);
            }
        }
        if (streamInfo.BackupEncodingsStatus.size >= playerTypes.length) {
            return textStr;
        }
        if (streamInfo.BackupEncodings && !streamInfo.BackupEncodings.includes(url)) {
            const streamM3u8Url = getStreamUrlForResolution(streamInfo.BackupEncodings, resolutionInfo);
            const streamM3u8Response = await realFetch(streamM3u8Url);
            if (streamM3u8Response.status === 200) {
                return await streamM3u8Response.text();
            }
        }
        const backupSearchStart = Date.now();
        let backupPlayerTypeInfo = '';
        for (let i = 0; i < playerTypes.length; i++) {
            const playerType = playerTypes[i];
            if (!streamInfo.BackupEncodingsStatus.has(playerType)) {
                try {
                    const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, playerType);
                    if (accessTokenResponse != null && accessTokenResponse.status !== 200) {
                        let errorBody = '';
                        try { errorBody = ' — ' + (await accessTokenResponse.text()).substring(0, 200); } catch {}
                        console.log('[AD DEBUG] アクセストークンの HTTP ' + accessTokenResponse.status + '（' + playerType + '）' + (accessTokenResponse.status === 403 ? '（integrity: ' + (ClientIntegrityHeader ? 'あり' : 'なし') + '）' : '') + errorBody);
                        streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                        if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                            streamInfo.LoggedTokenFailureStreak = true;
                            console.log('[AD DEBUG] トークン取得に失敗 — プレイヤータイプをまたいで ' + streamInfo.ConsecutiveTokenFetchFailures + ' 回連続。Twitch による検出 / integrity のローテーション / レート制限の可能性');
                        }
                    }
                    if (accessTokenResponse != null && accessTokenResponse.status === 200) {
                        const accessToken = await accessTokenResponse.json();
                        // Twitch が返す streamPlaybackAccessToken には次の 2 つの形状が観測されている:
                        //   { data: { streamPlaybackAccessToken: {...} } }（ほとんどのプレイヤータイプ）
                        //   { streamPlaybackAccessToken: {...} }（よりフラットな形。'embed' で観測）
                        // どちらも受け入れる。そうしないと embed のバックアップが黙って捨てられることが実地で確認されている。
                        const spat = accessToken?.data?.streamPlaybackAccessToken || accessToken?.streamPlaybackAccessToken;
                        if (!spat) {
                            const errInfo = accessToken?.errors ? ' errors: ' + JSON.stringify(accessToken.errors).substring(0, 300) : '';
                            console.log('[AD DEBUG] GQL のレスポンスに streamPlaybackAccessToken がありません（' + playerType + '）。レスポンスのキー: ' + JSON.stringify(Object.keys(accessToken || {})) + errInfo);
                            streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                            if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                                streamInfo.LoggedTokenFailureStreak = true;
                                console.log('[AD DEBUG] トークン取得に失敗 — プレイヤータイプをまたいで ' + streamInfo.ConsecutiveTokenFetchFailures + ' 回連続。Twitch による検出 / integrity のローテーション / レート制限の可能性');
                            }
                            continue;
                        }
                        const urlInfo = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
                        urlInfo.searchParams.set('sig', spat.signature);
                        urlInfo.searchParams.set('token', spat.value);
                        const encodingsM3u8Response = await realFetch(urlInfo.href);
                        if (encodingsM3u8Response != null && encodingsM3u8Response.status !== 200) {
                            console.log('[AD DEBUG] Usher の HTTP ' + encodingsM3u8Response.status + '（' + playerType + '）');
                        }
                        if (encodingsM3u8Response != null && encodingsM3u8Response.status === 200) {
                            streamInfo.ConsecutiveTokenFetchFailures = 0;
                            streamInfo.LoggedTokenFailureStreak = false;
                            let encodingsM3u8 = await encodingsM3u8Response.text();
                            const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, resolutionInfo);
                            const streamM3u8Response = await realFetch(streamM3u8Url);
                            if (streamM3u8Response.status === 200) {
                                const backTextStr = await streamM3u8Response.text();
                                if ((!hasAdTags(backTextStr) && (SimulatedAdsDepth == 0 || i >= SimulatedAdsDepth - 1)) || i >= playerTypes.length - 1) {
                                    result = backTextStr;
                                    backupPlayerTypeInfo = ' (' + playerType + ')';
                                    streamInfo.BackupEncodingsStatus.set(playerType, 1);
                                    streamInfo.BackupEncodingsPlayerTypeIndex = i;
                                    if (PinBackupPlayerType) {
                                        streamInfo.PinnedBackupPlayerType = playerType;
                                    }
                                    if (streamInfo.Encodings != null) {
                                        // 低解像度のストリームは UI に表示される解像度の数を減らしてしまう。これを避けるため、低解像度の URL をメインの m3u8 にマージする
                                        const normalEncodingsM3u8 = streamInfo.Encodings;
                                        const normalLines = normalEncodingsM3u8.split(/\r?\n/);
                                        for (let j = 0; j < normalLines.length - 1; j++) {
                                            if (normalLines[j].startsWith('#EXT-X-STREAM-INF')) {
                                                const resSettings = parseAttributes(normalLines[j].substring(normalLines[j].indexOf(':') + 1));
                                                const lowResUrl = getStreamUrlForResolution(encodingsM3u8, streamInfo.Urls.get(normalLines[j + 1].trimEnd()));
                                                const lowResInf = encodingsM3u8.match(new RegExp(`^.*(?=\n.*${lowResUrl})`, 'm'))?.[0];
                                                if (!lowResInf) continue;
                                                const lowResSettings = parseAttributes(lowResInf.substring(lowResInf.indexOf(':') + 1));
                                                const codecsKey = 'CODECS';
                                                if (typeof resSettings[codecsKey] === 'string' && typeof lowResSettings[codecsKey] === 'string' &&
                                                    resSettings[codecsKey].length >= 3 && lowResSettings[codecsKey].length >= 3 &&
                                                    (resSettings[codecsKey].startsWith('hev') || resSettings[codecsKey].startsWith('hvc')) &&
                                                    resSettings[codecsKey].substring(0, 3) !== lowResSettings[codecsKey].substring(0, 3)
                                                ) {
                                                    console.log('切り替え ' + resSettings[codecsKey] + ' → ' + lowResSettings[codecsKey]);
                                                    normalLines[j] = normalLines[j].replace(/CODECS="[^"]+"/, `CODECS="${lowResSettings[codecsKey]}"`);
                                                    console.log(normalLines[j]);
                                                }
                                                normalLines[j + 1] = lowResUrl + ' '.repeat(j + 1);// 各 URL の行が一意でないとストリームが読み込まれない
                                            }
                                        }
                                        encodingsM3u8 = normalLines.join('\n');
                                    }
                                    streamInfo.BackupEncodings = encodingsM3u8;
                                    setStreamInfoUrls(streamInfo, encodingsM3u8);
                                }
                            }
                        }
                    }
                } catch (err) { console.error(err); }
                if (streamInfo.BackupEncodingsStatus.get(playerType) === 1) {
                    break;
                } else {
                    streamInfo.BackupEncodingsStatus.set(playerType, 0);
                }
            }
        }
        console.log('広告を検出したためバックアップに切り替えます' + backupPlayerTypeInfo + '（' + (Date.now() - backupSearchStart) + 'ms）— シグニファイア: ' + getMatchedAdSignifiers(textStr).join(', '));
        if (reloadPlayer) {
            postMessage({key: ReloadPlayerAfterAd ? 'UboReloadPlayer' : 'UboPauseResumePlayer'});
        }
        updateAdblockBannerForStream(streamInfo);
        return result;
    }
    function hasAdTags(textStr) {
        return AD_SIGNIFIERS.some((s) => s && textStr.includes(s));
    }
    function getMatchedAdSignifiers(textStr) {
        return AD_SIGNIFIERS.filter((s) => textStr.includes(s));
    }
    function stripAdSegments(textStr, stripAllSegments, streamInfo) {
        let hasStrippedAdSegments = false;
        let inCueOut = false;
        const liveSegments = [];
        const lines = textStr.split(/\r?\n/);
        const newAdUrl = 'https://twitch.tv';
        // 広告トラッキングの属性名をストリームごとに 1 回ログ出力する（新しいビーコンの特定に役立つ）
        if (!streamInfo.HasLoggedAdAttributes) {
            const adAttrs = textStr.match(/X-TV-TWITCH-AD[A-Z-]*(?==")/g);
            if (adAttrs && adAttrs.length > 0) {
                streamInfo.HasLoggedAdAttributes = true;
                console.log('[AD DEBUG] 観測した広告トラッキングの属性: ' + [...new Set(adAttrs)].join(', '));
            }
        }
        // AD_SIGNIFIERS に含まれていない広告マーカー候補をログに出力する（今後追加する候補）
        if (!streamInfo.HasLoggedUnknownSignifiers) {
            const candidates = new Set();
            let sm;
            const classRe = /EXT-X-DATERANGE:[^\n]*CLASS="(twitch-[^"]+)"/g;
            while ((sm = classRe.exec(textStr)) !== null) {
                candidates.add('EXT-X-DATERANGE:CLASS="' + sm[1] + '"');
            }
            const tagRe = /(SCTE35-[A-Z-]+|EXT-X-CUE-[A-Z-]+)/g;
            while ((sm = tagRe.exec(textStr)) !== null) {
                candidates.add(sm[1]);
            }
            // 部分一致による判定（完全一致ではない）: いずれかの AD_SIGNIFIER が含まれていれば、
            // その候補は「既知」とみなす。これにより 'twitch-stitched' のような接頭辞のシグニファイアが
            // 'EXT-X-DATERANGE:CLASS="twitch-stitched-ad"' などを網羅できる。
            const unknown = [...candidates].filter(c =>
                !AD_SIGNIFIERS.some(s => s && c.includes(s)) &&
                !KNOWN_NON_AD_SIGNIFIERS.some(s => s && c.includes(s))
            );
            if (unknown.length > 0) {
                streamInfo.HasLoggedUnknownSignifiers = true;
                console.log('[AD DEBUG] AD_SIGNIFIERS にない広告マーカー候補を検出: ' + unknown.join(', ') + '（今後追加する候補）');
            }
        }
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            // SCTE-35 の CUE-OUT / CUE-IN による広告の境界を追跡する
            if (line.includes('EXT-X-CUE-OUT')) {
                if (!inCueOut) {
                    console.log('[AD DEBUG] SCTE-35 CUE-OUT — 広告の境界に入りました');
                }
                inCueOut = true;
            } else if (line.includes('EXT-X-CUE-IN')) {
                if (inCueOut) {
                    console.log('[AD DEBUG] SCTE-35 CUE-IN — 広告の境界を抜けました');
                }
                inCueOut = false;
            }
            // オーバーレイ UI に現れるトラッキング URL を除去する
            lines[i] = line.replaceAll(TWITCH_AD_URL_REWRITE_REGEX, `$1${newAdUrl}$2`);
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!line.includes(',live') || stripAllSegments || AllSegmentsAreAdSegments || inCueOut)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    streamInfo.NumStrippedAdSegments++;
                }
                AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && AD_SEGMENT_URL_PATTERNS.some((p) => lines[i + 1].includes(p))) {
                console.log('[AD DEBUG] URL パターンから広告セグメントを検出: ' + lines[i + 1]);
                AdSegmentCache.set(lines[i + 1], Date.now());
                hasStrippedAdSegments = true;
                streamInfo.NumStrippedAdSegments++;
            } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && line.includes(',live')) {
                liveSegments.push({ extinf: line, url: lines[i + 1] });
            } else if (line.startsWith('#EXT-X-PART:')) {
                // LL-HLS のパート: URI は属性としてインラインに書かれている。既知の広告 URL に一致する場合は除去する
                // （並行する EXTINF の除去によりすでにキャッシュにあるか、URL パターンに一致する場合）。
                // これがないと、プレイヤーが低遅延のパート経路から広告メディアを取得してしまう可能性がある。
                const partUriMatch = line.match(URI_ATTRIBUTE_REGEX);
                const partUri = partUriMatch ? partUriMatch[1] : '';
                if (partUri && (AdSegmentCache.has(partUri) || AD_SEGMENT_URL_PATTERNS.some((p) => partUri.includes(p)))) {
                    AdSegmentCache.set(partUri, Date.now());
                    lines[i] = '';
                    hasStrippedAdSegments = true;
                }
            } else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:') || line.startsWith('#EXT-X-PRELOAD-HINT:')) {
                // LL-HLS の prefetch / preload のヒントは、EXTINF の行や広告シグニファイアがプレイリストに
                // 現れる前に、これから来る広告セグメントを指していることがある。hasStrippedAdSegments が
                // 立った後にしか prefetch のヒントを除去しないと、広告の最初のポーリングで広告 URL を指す
                // ヒントが漏れてしまう。すると通常の除去が追いつく前に、プレイヤーが LL-HLS の経路で
                // 広告のメディアを先読みし、広告が一瞬表示される。ここで広告 URL を検出することで、
                // 最初のポーリングで hasStrippedAdSegments が true になり、ループ後の無条件の prefetch 除去が
                // 発火する。TTV-AB 52b41b4 から移植。
                let hintUrl = '';
                if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    hintUrl = line.substring('#EXT-X-TWITCH-PREFETCH:'.length).trim();
                } else {
                    const hintMatch = line.match(/URI="([^"]+)"/);
                    hintUrl = hintMatch ? hintMatch[1] : '';
                }
                if (hintUrl && (AdSegmentCache.has(hintUrl) || AD_SEGMENT_URL_PATTERNS.some((p) => hintUrl.includes(p)))) {
                    AdSegmentCache.set(hintUrl, Date.now());
                    hasStrippedAdSegments = true;
                }
            }
        }
        // 行ごとのループから外に出した: シグニファイアを行ごとに走査するのは
        // 全文を 1 回走査するのと意味的に等価である。このチェックは行単位の状態を持たず、
        // 最初に一致した時点で hasStrippedAdSegments = true にするだけだからである。
        // N_lines * N_signifiers 回ではなく 1 回の走査で済む（典型的な 100 行の m3u8 で
        // includes() の呼び出しが約 100 分の 1 になる）。
        if (!hasStrippedAdSegments && hasAdTags(textStr)) {
            hasStrippedAdSegments = true;
        }
        if (hasStrippedAdSegments) {
            for (let i = 0; i < lines.length; i++) {
                // 広告中は低遅延を無効化する（有効なままだとプレイヤーが広告セグメントを先読みして表示する可能性がある）
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:') || lines[i].startsWith('#EXT-X-PRELOAD-HINT:')) {
                    lines[i] = '';
                }
            }
        } else {
            streamInfo.NumStrippedAdSegments = 0;
        }
        // 復旧用にライブセグメントをキャッシュする（あわせてキャッシュ内で最も古いセグメントの MEDIA-SEQUENCE も保持し、
        // 注入した復旧セグメントをプレイヤーがストリーム内の正しい位置として受け入れられるようにする）
        if (liveSegments.length > 0) {
            streamInfo.RecoverySegments = liveSegments.slice(-6);
            const seq = parseInt((textStr.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/) || [])[1]);
            if (!isNaN(seq)) {
                streamInfo.RecoveryStartSeq = seq + Math.max(0, liveSegments.length - streamInfo.RecoverySegments.length);
            }
        }
        // すべてのセグメントが除去された場合は、復旧用のコンテンツで黒画面を防ぐことを試みる。
        // 直近の広告なしポーリングで取得したプレイリスト全体のスナップショットを優先する
        // （TTV-AB の LastCleanNativeM3U8 と同じ方式）。薄いセグメント単位の復旧キャッシュと違い、
        // ライブセグメント 4〜6 個分の内容をプレイヤーに渡せる。スナップショットが古いか存在しない場合は
        // セグメント単位のキャッシュにフォールバックする。
        if (hasStrippedAdSegments && liveSegments.length === 0) {
            streamInfo.ConsecutiveAllStrippedPolls = (streamInfo.ConsecutiveAllStrippedPolls || 0) + 1;
            // 早期再読み込み: 復旧キャッシュが薄い場合（3 セグメント未満）は最初のポーリングで発動し、
            // それ以外は EarlyReloadPollThreshold 回のポーリング（約 10 秒）を待つ。
            const recoveryThin = (streamInfo.RecoverySegments?.length || 0) < 3;
            const effectiveThreshold = recoveryThin ? 1 : EarlyReloadPollThreshold;
            if (EarlyReloadPollThreshold > 0 && streamInfo.ConsecutiveAllStrippedPolls >= effectiveThreshold && !streamInfo.EarlyReloadTriggered) {
                streamInfo.EarlyReloadTriggered = true;
                const reason = recoveryThin ? ' (thin recovery cache: ' + (streamInfo.RecoverySegments?.length || 0) + ' segments)' : '';
                console.log('[AD DEBUG] 早期再読み込みを発動 — 全セグメント除去のポーリングが ' + streamInfo.ConsecutiveAllStrippedPolls + ' 回連続' + reason);
                // kind: 'early' は、これがキャッシュが薄い場合 / フリーズからの復旧の高速経路であることを
                // メインスレッドの再読み込みハンドラーに伝え、バッファ監視による再読み込みの連鎖を防ぐための
                // クールダウンの判定を迂回させる。これがないと、プレイヤーが固まったときにこそ発動すべき
                // 再読み込みが、クールダウンによって打ち消されてしまう。
                postMessage({ key: 'UboReloadPlayer', kind: 'early' });
            }
            // メイン: 新しいプレイリスト全体のスナップショット（1.5 秒以内のもので、それ自体が広告マーカーを含まないこと）
            const snapshotAge = streamInfo.LastCleanNativePlaylistAt ? (Date.now() - streamInfo.LastCleanNativePlaylistAt) : Infinity;
            if (streamInfo.LastCleanNativeM3U8 && snapshotAge <= 1500 && !hasAdTags(streamInfo.LastCleanNativeM3U8)) {
                console.log('[AD DEBUG] 全セグメントを除去 — 直近のクリーンなネイティブのプレイリストを再利用します（' + snapshotAge + 'ms 前のもの）');
                streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
                return streamInfo.LastCleanNativeM3U8;
            }
            // フォールバック: セグメント単位の復旧キャッシュ（従来の挙動）
            if (streamInfo.RecoverySegments && streamInfo.RecoverySegments.length > 0) {
                console.log('[AD DEBUG] 全セグメントを除去 — 復旧セグメントを ' + streamInfo.RecoverySegments.length + ' 個復元します');
                if (streamInfo.RecoveryStartSeq !== undefined) {
                    for (let j = 0; j < lines.length; j++) {
                        if (lines[j].startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                            lines[j] = '#EXT-X-MEDIA-SEQUENCE:' + streamInfo.RecoveryStartSeq;
                            break;
                        }
                    }
                }
                for (let j = 0; j < streamInfo.RecoverySegments.length; j++) {
                    lines.push(streamInfo.RecoverySegments[j].extinf);
                    lines.push(streamInfo.RecoverySegments[j].url);
                }
            }
        }
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        const now = Date.now();
        // キャッシュの整理は 60 秒に 1 回に制限する。TTL が 120 秒あるので余裕は十分あり、
        // m3u8 をポーリングするたびにキャッシュ全体を走査すると、広告が連続する場面では負荷が積み上がる
        // （LL-HLS では 1 秒間に複数回ポーリングされることがある）。TTV-AB から移植。
        if (!streamInfo.LastAdCachePruneAt || now - streamInfo.LastAdCachePruneAt > 60000) {
            streamInfo.LastAdCachePruneAt = now;
            AdSegmentCache.forEach((value, key, map) => {
                if (value < now - 120000) {
                    map.delete(key);
                }
            });
            // 診断: キャッシュが 1000 件を超えたら streamInfo ごとに 1 回ログを出す。
            // これにより、将来 TTL や整理処理のバグでキャッシュが肥大化しても、見えないままにならず
            // ユーザーの報告に現れるようにする。
            if (AdSegmentCache.size > 1000 && !streamInfo.LoggedAdCacheSize1k) {
                streamInfo.LoggedAdCacheSize1k = true;
                console.log('[AD DEBUG] AdSegmentCache が 1000 件を超えました（現在 ' + AdSegmentCache.size + ' 件）— キャッシュの肥大化の可能性があります');
            }
        }
        return lines.join('\n');
    }
    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }
        streamInfo.LastSeenAt = Date.now();
        if (!streamInfo.LoggedOfflineTransition && textStr.includes('#EXT-X-ENDLIST') && !textStr.includes('#EXTINF:')) {
            streamInfo.LoggedOfflineTransition = true;
            console.log('[AD DEBUG] 配信終了 / オフラインの形を検出 — m3u8 に #EXT-X-ENDLIST があり、セグメントがありません。Twitch による検出への対応、配信者による配信終了、または通常の配信終了の可能性があります');
        }
        const currentResolution = streamInfo.Urls.get(url);
        if (!currentResolution) {
            return textStr;
        }
        if (!streamInfo.HasCheckedUnknownTags) {
            streamInfo.HasCheckedUnknownTags = true;
            const unknownAdTags = textStr.match(/#EXT[^:\n]*(?:ad|cue|scte|sponsor)[^:\n]*/gi);
            if (unknownAdTags) {
                const unknown = unknownAdTags.filter(t => !AD_SIGNIFIERS.some(s => s && t.includes(s)));
                if (unknown.length > 0) {
                    console.log('[AD DEBUG] 未知の広告関連タグを検出: ' + [...new Set(unknown)].join(', '));
                }
            }
        }
        const haveAdTags = hasAdTags(textStr) || (SimulatedAdsDepth > 0 && (!streamInfo.BackupEncodings || !streamInfo.BackupEncodings.includes(url) || SimulatedAdsDepth - 1 > streamInfo.BackupEncodingsPlayerTypeIndex));
        // 全セグメントが除去された場合の復旧フォールバック用に、クリーンなメインストリームの m3u8 をキャッシュする。
        // 広告のないポーリング時（広告の外側）に更新されるため、広告が始まる時点で
        // streamInfo.LastCleanNativeM3U8 には 1〜2 秒前のスナップショットが入っており、ライブセグメントも
        // 複数含まれている。SSAI の重い広告でメインのプレイリストが完全に除去されてしまう場合、
        // stripAdSegments は薄い RecoverySegments の配列ではなくこのスナップショットを再生する。
        // 通常、個別にキャッシュした 1〜2 個のセグメントに対して、ライブセグメント 4〜6 個分の
        // 内容をプレイヤーに渡せる。
        // TTV-AB の src/modules/processor.ts:733-736 に準拠。
        if (!haveAdTags && !streamInfo.BackupEncodings && textStr.indexOf('#EXTINF') !== -1) {
            streamInfo.LastCleanNativeM3U8 = textStr;
            streamInfo.LastCleanNativePlaylistAt = Date.now();
        }
        if (streamInfo.BackupEncodings) {
            const streamM3u8Url = streamInfo.Encodings.match(/^https:.*\.m3u8$/m)?.[0];
            const streamM3u8Response = await realFetch(streamM3u8Url);
            if (streamM3u8Response.status == 200) {
                const streamM3u8 = await streamM3u8Response.text();
                if (streamM3u8 != null) {
                    if (!hasAdTags(streamM3u8) && SimulatedAdsDepth == 0) {
                        // 今回の広告でメインストリームが最初にクリーンになったポーリングの時点でタイムスタンプを記録し、
                        // その後のポーリングが再び広告ありに戻っても、下の低速経路の最大待機による判定が発火できるようにする。
                        // TTV-AB v6.6.7 の #1 に準拠。
                        if (!streamInfo.PendingAdEndAt) {
                            streamInfo.PendingAdEndAt = Date.now();
                        }
                        streamInfo.CleanPlaylistCount++;
                        // 現在のプレイリストにライブセグメントがあるか確認する。なければバックアップストリームは停止している
                        const hasLiveSegments = textStr.includes(LIVE_SIGNIFIER);
                        // 低速経路の最大待機による独立した段階的移行 — マーカーが揺れて CleanPlaylistCount が
                        // しきい値に届かない場合でも、目に見える広告のサイクルを終わらせる。これがないと、
                        // Twitch がマーカーを 2 回連続のクリーンなポーリングより速く出し入れするチャンネルでは、
                        // プレイヤーがバックアップに張り付いたままになりかねない。TTV-AB v6.6.7 の #4
                        // （「低速経路の復旧をクリーン回数から切り離す」）に準拠。
                        const adEndMaxWaitMs = 12000;
                        const elapsedSinceCandidate = Date.now() - streamInfo.PendingAdEndAt;
                        const slowPathReady = streamInfo.PendingAdEndAt > 0 && elapsedSinceCandidate >= adEndMaxWaitMs;
                        if (streamInfo.CleanPlaylistCount >= 2 || !hasLiveSegments || slowPathReady) {
                            if (slowPathReady && streamInfo.CleanPlaylistCount < 2) {
                                console.log('[AD DEBUG] 低速経路による広告終了の判定 — マーカーの揺れ ' + (streamInfo.AdEndBounceCount || 0) + ' 回、最初のクリーンなポーリングから ' + (elapsedSinceCandidate / 1000).toFixed(1) + ' 秒');
                            }
                            if (!hasLiveSegments) {
                                console.log('[AD DEBUG] バックアップストリームにライブセグメントがありません — 即時に再読み込みします');
                            }
                            console.log('メインストリームの広告が終了しました。広告セグメントを ' + streamInfo.NumStrippedAdSegments + ' 個除去しました。' + (ReloadPlayerAfterAd ? 'メインストリームに戻るためプレイヤーを再読み込みします...' : '再生を再開します...'));
                            // 誤検出のガードに数えるのは、m3u8 に信頼度の高い広告マーカーがなかった場合に限る。
                            // 確定した広告（X-TV-TWITCH-AD-AD-SESSION-ID などを伴うもの）で除去が 0 件なのは、
                            // クリーンなバックアップによってうまく回避できた本物の広告であり、誤検出ではない。
                            if (streamInfo.NumStrippedAdSegments === 0 && !streamInfo.HasConfirmedAdAttrs) {
                                streamInfo.ConsecutiveZeroStripBreaks++;
                                if (streamInfo.ConsecutiveZeroStripBreaks >= 3) {
                                    console.log('[AD DEBUG] 警告: 除去 0 件で未確定の広告が ' + streamInfo.ConsecutiveZeroStripBreaks + ' 回連続しています — 広告シグニファイアによる誤検出の可能性があります');
                                }
                            } else if (streamInfo.NumStrippedAdSegments > 0) {
                                streamInfo.ConsecutiveZeroStripBreaks = 0;
                            }
                            streamInfo.HasConfirmedAdAttrs = false;
                            streamInfo.HasLoggedCsaiFastPath = false;
                            streamInfo.HasLoggedCsaiToSsaiTransition = false;
                            streamInfo.HasLoggedAdAttributes = false;
                            streamInfo.HasLoggedUnknownSignifiers = false;
                            streamInfo.RequestedAds?.clear?.();
                            streamInfo.ConsecutiveAllStrippedPolls = 0;
                            streamInfo.EarlyReloadTriggered = false;
                            streamInfo.IsMovingOffBackupEncodings = true;
                            streamInfo.BackupEncodings = null;
                            streamInfo.BackupEncodingsStatus?.clear?.();
                            streamInfo.BackupEncodingsPlayerTypeIndex = -1;
                            streamInfo.CleanPlaylistCount = 0;
                            streamInfo.PendingAdEndAt = 0;
                            streamInfo.AdEndBounceCount = 0;
                            postMessage({key: ReloadPlayerAfterAd ? 'UboReloadPlayer' : 'UboPauseResumePlayer'});
                        }
                    } else {
                        // 揺れに強いリセット: 広告マーカーが短時間戻る程度では PendingAdEndAt を維持し、
                        // マーカーが揺れて CleanPlaylistCount がしきい値に届かない場合でも、低速経路の最大待機による
                        // 判定が発火できるようにする。TTV-AB v6.6.7 の #1 に準拠。
                        const adEndStalenessMs = 12000;
                        if (streamInfo.PendingAdEndAt && (Date.now() - streamInfo.PendingAdEndAt) < adEndStalenessMs) {
                            streamInfo.AdEndBounceCount = (streamInfo.AdEndBounceCount || 0) + 1;
                        } else {
                            streamInfo.PendingAdEndAt = 0;
                            streamInfo.AdEndBounceCount = 0;
                        }
                        streamInfo.CleanPlaylistCount = 0;
                        if (!streamM3u8.includes('"MIDROLL"') && !streamM3u8.includes('"midroll"')) {
                            const lines = streamM3u8.split(/\r?\n/);
                            for (let i = 0; i < lines.length; i++) {
                                const line = lines[i];
                                if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                                    if (!line.includes(LIVE_SIGNIFIER) && !streamInfo.RequestedAds.has(lines[i + 1])) {
                                        // .m3u8 のリクエスト 1 回につき .ts ファイルを 1 つだけ要求し、リクエストが多くなりすぎないようにする
                                        streamInfo.RequestedAds.add(lines[i + 1]);
                                        fetch(lines[i + 1]).then((response) => response.blob()).catch(() => {});
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (streamInfo.BackupEncodings && haveAdTags) {
                textStr = await onFoundAd(streamInfo, textStr, true, realFetch, url, currentResolution);
            }
        } else if (haveAdTags && !streamInfo.IsMovingOffBackupEncodings) {
            // CSAI 高速経路: メインストリームのセグメントがすべてライブであれば、バックアップの探索を省略する。
            // CSAI の広告は m3u8 の外部で配信されるため、メインストリームのセグメントはクリーンである。
            // メインストリームをそのまま返し、20〜40 秒の再バッファリングの空白を招くバックアップストリームへの
            // 切り替えを回避する。
            const mainStreamLines = textStr.split(/\r?\n/);
            let hasNonLiveSegment = false;
            for (let i = 0; i < mainStreamLines.length; i++) {
                if (mainStreamLines[i].startsWith('#EXTINF') && !mainStreamLines[i].includes(LIVE_SIGNIFIER)) {
                    hasNonLiveSegment = true;
                    break;
                }
            }
            if (!hasNonLiveSegment) {
                if (!streamInfo.HasLoggedCsaiFastPath) {
                    streamInfo.HasLoggedCsaiFastPath = true;
                    // 「all segments live, skipping backup search」から表現を変更した。元の書き方は恒久的な状態のように
                    // 読めたが、実際には今回のポーリングについて述べているだけである。Twitch は広告の途中で、
                    // CSAI のトラッキングピクセルのみの状態から SSAI の stitched なセグメントに切り替えることがあり、
                    // その時点でバックアップ探索は正当に発動する。CSAI→SSAI の遷移は下で別途ログに出力される。
                    console.log('[AD DEBUG] CSAI 高速経路 — 今回のポーリングは全セグメントがライブのため、このポーリングではバックアップ探索を省略します（以降のポーリングでプレイリストが SSAI に変わる可能性があります）');
                }
            } else {
                if (streamInfo.HasLoggedCsaiFastPath && !streamInfo.HasLoggedCsaiToSsaiTransition) {
                    streamInfo.HasLoggedCsaiToSsaiTransition = true;
                    console.log('[AD DEBUG] プレイリストに stitched な広告セグメントが含まれるようになりました — CSAI 高速経路は適用されなくなったため、バックアップ探索に移行します');
                }
                textStr = await onFoundAd(streamInfo, textStr, true, realFetch, url, currentResolution);
            }
        }
        if (IsAdStrippingEnabled) {
            textStr = stripAdSegments(textStr, false, streamInfo);
        }
        updateAdblockBannerForStream(streamInfo);
        return textStr;
    }
    function hookWorkerFetch() {
        console.log('[AD DEBUG] hookWorkerFetch (video-swap-new)');
        const realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                if (AdSegmentCache.has(url)) {
                    return new Promise(function(resolve, reject) {
                        realFetch('data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA', options).then(function(response) {
                            resolve(response);
                        })['catch'](function(err) {
                            reject(err);
                        });
                    });
                }
                url = url.trimEnd();
                if (url.endsWith('m3u8')) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                const str = await processM3U8(url, await response.text(), realFetch);
                                resolve(new Response(str, {
                                    status: response.status,
                                    statusText: response.statusText,
                                    headers: response.headers
                                }));
                            } else {
                                resolve(response);
                            }
                        };
                        realFetch(url, options).then(function(response) {
                            processAfter(response);
                        })['catch'](function(err) {
                            const errMsg = String(err?.message || err);
                            if (err?.name !== 'AbortError' && !/cancel|abort/i.test(errMsg)) console.log('fetch フックのエラー: ' + err);
                            reject(err);
                        });
                    });
                }
                else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const channelName = (new URL(url)).pathname.match(/([^\/]+)(?=\.\w+$)/)?.[0];
                    if (OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE) {
                        // parent_domains はプレイヤーが埋め込みかどうかの判定に使われるため、これを除去すると偽の広告がなくなる
                        const tempUrl = new URL(url);
                        tempUrl.searchParams.delete('parent_domains');
                        url = tempUrl.toString();
                    }
                    return new Promise(async function(resolve, reject) {
                        // - 最初の m3u8 リクエストは、動画のエンコーディング（360p、480p、720p など）を含む m3u8 である。
                        // - 2 番目の m3u8 リクエストは、最初のリクエストで得た特定のエンコーディング用の m3u8 である。この時点で広告の有無が分かる。
                        let streamInfo = StreamInfos[channelName];
                        if (streamInfo != null && streamInfo.Encodings != null && (await realFetch(streamInfo.Encodings.match(/^https:.*\.m3u8$/m)?.[0])).status !== 200) {
                            // キャッシュしていた encodings が無効になっている（おそらく配信が再開された）
                            streamInfo = null;
                        }
                        let serverTime = null;
                        if (streamInfo == null || streamInfo.Encodings == null) {
                            StreamInfos[channelName] = streamInfo = createStreamInfo(channelName, (new URL(url)).search);
                            const encodingsM3u8Response = await realFetch(url, options);
                            if (encodingsM3u8Response != null && encodingsM3u8Response.status === 200) {
                                const encodingsM3u8 = await encodingsM3u8Response.text();
                                streamInfo.Encodings = encodingsM3u8;
                                setStreamInfoUrls(streamInfo, encodingsM3u8);
                                serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                const resolutionInfo = streamInfo.Urls.values().next().value;
                                const streamM3u8Response = await realFetch(resolutionInfo.Url);
                                if (streamM3u8Response.status == 200) {
                                    const streamM3u8 = await streamM3u8Response.text();
                                    if (hasAdTags(streamM3u8) || SimulatedAdsDepth > 0) {
                                        await onFoundAd(streamInfo, streamM3u8, false, realFetch, resolutionInfo.Url, resolutionInfo);
                                    }
                                } else {
                                    resolve(streamM3u8Response);
                                    return;
                                }
                            } else {
                                resolve(encodingsM3u8Response);
                                return;
                            }
                        }
                        if (!serverTime) {
                            const encodingsM3u8Response = await realFetch(url, options);
                            if (encodingsM3u8Response != null && encodingsM3u8Response.status === 200) {
                                serverTime = getServerTimeFromM3u8(await encodingsM3u8Response.text());
                            }
                        }
                        streamInfo.IsMovingOffBackupEncodings = false;
                        resolve(new Response(replaceServerTimeInM3u8(streamInfo.BackupEncodings ? streamInfo.BackupEncodings : streamInfo.Encodings, serverTime)));
                    });
                }
            }
            return realFetch.apply(this, arguments);
        }
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
    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
        const encodingsLines = encodingsM3u8.split(/\r?\n/);
        const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
        let matchedResolutionUrl = null;
        let matchedFrameRate = false;
        let closestResolutionUrl = null;
        let closestResolutionDifference = Infinity;
        for (let i = 0; i < encodingsLines.length - 1; i++) {
            // v2 API の URL 形式（'.m3u8' を含まない生の CDN URL）も受け入れる。
            const nextLine = encodingsLines[i + 1]?.trim();
            if (encodingsLines[i].startsWith('#EXT-X-STREAM-INF') && nextLine && !nextLine.startsWith('#') && (nextLine.includes('.m3u8') || nextLine.includes('://'))) {
                const attributes = parseAttributes(encodingsLines[i]);
                const resolution = attributes['RESOLUTION'];
                const frameRate = attributes['FRAME-RATE'];
                if (resolution) {
                    if (resolution == resolutionInfo.Resolution && (!matchedResolutionUrl || (!matchedFrameRate && frameRate == resolutionInfo.FrameRate))) {
                        matchedResolutionUrl = encodingsLines[i + 1];
                        matchedFrameRate = frameRate == resolutionInfo.FrameRate;
                        if (matchedFrameRate) {
                            return matchedResolutionUrl.trimEnd();
                        }
                    }
                    const [width, height] = resolution.split('x').map(Number);
                    const difference = Math.abs((width * height) - (targetWidth * targetHeight));
                    if (difference < closestResolutionDifference) {
                        closestResolutionUrl = encodingsLines[i + 1];
                        closestResolutionDifference = difference;
                    }
                }
            }
        }
        return closestResolutionUrl.trimEnd();
    }
    function getAccessToken(channelName, playerType) {
        const realPlayerType = playerType.replace('-ALT', '');
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: "",
                playerType: realPlayerType,
                platform: 'web'
            },
            extensions: {
                persistedQuery: {
                    version:1,
                    sha256Hash:"ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
                }
            }
        };
        return gqlRequest(body);
    }
    function gqlRequest(body) {
        if (!gql_device_id) {
            gql_device_id = '';
            const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            for (let i = 0; i < 32; i += 1) {
                gql_device_id += chars.charAt(Math.floor(Math.random() * chars.length));
            }
        }
        let headers = {
            'Client-Id': CLIENT_ID,
            'X-Device-Id': gql_device_id,
            'Authorization': AuthorizationHeader,
            ...(ClientIntegrityHeader && {'Client-Integrity': ClientIntegrityHeader})
        };
        if (playerType.includes('-ALT')) {
            headers = {
                'Client-Id': CLIENT_ID,
                'X-Device-Id': gql_device_id
            };
        }
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 15);
            const fetchRequest = {
                id: requestId,
                url: 'https://gql.twitch.tv/gql',
                options: {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers
                }
            };
            const timeoutId = setTimeout(() => {
                if (pendingFetchRequests.has(requestId)) {
                    pendingFetchRequests.delete(requestId);
                    reject(new Error('FetchRequest timed out'));
                }
            }, 15000);
            pendingFetchRequests.set(requestId, {
                resolve,
                reject,
                timeoutId
            });
            postMessage({
                key: 'FetchRequest',
                value: fetchRequest
            });
        });
    }
    function parseAttributes(str) {
        if (!str) return {};
        // 正規化: 常に属性部分のみを渡す
        if (str.charCodeAt(0) === 35) { // '#'
            const idx = str.indexOf(':');
            if (idx !== -1) str = str.slice(idx + 1);
        }
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
                .filter(Boolean)
                .map(x => {
                    const idx = x.indexOf('=');
                    const key = x.substring(0, idx);
                    const value = x.substring(idx +1);
                    const num = Number(value);
                    return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num]
                }));
    }
    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach((worker) => {
            worker.postMessage({key: key, value: value});
        });
    }
    async function handleWorkerFetchRequest(fetchRequest) {
        // AbortController による 5 秒のタイムアウト。Twitch の GQL が応答しない場合の最悪の待ち時間を抑える。
        const controller = new AbortController();
        const timeoutMs = 5000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await window.realFetch(fetchRequest.url, {
                ...fetchRequest.options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const responseBody = await response.text();
            const responseObject = {
                id: fetchRequest.id,
                status: response.status,
                statusText: response.statusText,
                ok: response.ok,
                redirected: response.redirected,
                type: response.type,
                url: response.url,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
            return responseObject;
        } catch (error) {
            clearTimeout(timeoutId);
            return {
                id: fetchRequest.id,
                error: error.name === 'AbortError' ? 'GQL fetch timeout (' + (timeoutMs / 1000) + 's)' : error.message
            };
        }
    }
    function hookFetch() {
        console.log('[AD DEBUG] window の fetch フックを設定しました');
        let hasLoggedHeaders = false;
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = maskAsNative(function(url, init) {
            if (typeof url === 'string') {
                if (url.includes('gql')) {
                    let deviceId = init.headers['X-Device-Id'];
                    if (typeof deviceId !== 'string') {
                        deviceId = init.headers['Device-ID'];
                    }
                    if (typeof deviceId === 'string' && gql_device_id != deviceId) {
                        gql_device_id = deviceId;
                        postTwitchWorkerMessage('UboUpdateDeviceId', gql_device_id);
                    }
                    if (typeof init.headers['Client-Integrity'] === 'string' && init.headers['Client-Integrity'] !== ClientIntegrityHeader) {
                        postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = init.headers['Client-Integrity']);
                    }
                    if (typeof init.headers['Authorization'] === 'string' && init.headers['Authorization'] !== AuthorizationHeader) {
                        postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = init.headers['Authorization']);
                    }
                    if (!hasLoggedHeaders && gql_device_id && AuthorizationHeader) {
                        hasLoggedHeaders = true;
                        console.log('[AD DEBUG] GQL のヘッダーを取得 — DeviceId: ' + (gql_device_id ? 'あり' : 'なし') + '、Auth: ' + (AuthorizationHeader ? 'あり' : 'なし') + '、Integrity: ' + (ClientIntegrityHeader ? 'あり' : 'なし'));
                    }
                    // チャット上部のミニプレイヤーを除去する - TODO: サーバー側で拒否させるのではなく、ローカルで拒否するようにする
                    if (init && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken') && init.body.includes('picture-by-picture')) {
                        init.body = '';
                    }
                    if (OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken')) {
                        let replacedPlayerType = '';
                        const newBody = JSON.parse(init.body);
                        if (Array.isArray(newBody)) {
                            for (let i = 0; i < newBody.length; i++) {
                                if (newBody[i]?.variables?.playerType && newBody[i]?.variables?.playerType !== OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE) {
                                    replacedPlayerType = newBody[i].variables.playerType;
                                    newBody[i].variables.playerType = OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE;
                                }
                            }
                        } else {
                            if (newBody?.variables?.playerType && newBody?.variables?.playerType !== OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE) {
                                replacedPlayerType = newBody.variables.playerType;
                                newBody.variables.playerType = OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE;
                            }
                        }
                        if (replacedPlayerType) {
                            console.log(`[AD DEBUG] プレイヤータイプ '${replacedPlayerType}' を '${OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE}' に置き換えました`);
                            init.body = JSON.stringify(newBody);
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
        }, 'fetch');
    }
    function updateAdblockBanner(data) {
        const playerRootDiv = document.querySelector('.video-player');
        if (playerRootDiv != null) {
            let adBlockDiv = null;
            adBlockDiv = playerRootDiv.querySelector('.tas-adblock-overlay');
            if (adBlockDiv == null) {
                adBlockDiv = document.createElement('div');
                adBlockDiv.className = 'tas-adblock-overlay';
                adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;"><p></p></div>';
                adBlockDiv.style.display = 'none';
                adBlockDiv.P = adBlockDiv.querySelector('p');
                playerRootDiv.appendChild(adBlockDiv);
            }
            if (adBlockDiv != null) {
                if (!twitchPlayerAndState?.player?.core || !twitchPlayerAndState?.state) {
                    twitchPlayerAndState = getPlayerAndState();
                }
                const isLive = twitchPlayerAndState?.state?.props?.content?.type === 'live';
                adBlockDiv.P.textContent = (data.isMidroll ? 'ミッドロール' : '') + '広告をブロック中' + (data.isStrippingAdSegments ? '（除去中）' : '') + (data.activeBackupPlayerType ? '（' + data.activeBackupPlayerType + '）' : '');
                adBlockDiv.style.display = data.hasAds && isLive ? 'block' : 'none';
            }
        }
    }
    function monitorLiveStatus() {
        if (!twitchPlayerAndState?.player?.core || !twitchPlayerAndState?.state) {
            twitchPlayerAndState = getPlayerAndState();
        }
        const isLive = twitchPlayerAndState?.state?.props?.content?.type === 'live';
        if (!isLive) {
            updateAdblockBanner({
                hasAds: false
            });
        }
        setTimeout(monitorLiveStatus, 1000);
    }
    function getPlayerAndState() {
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
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer') || x.startsWith('__reactFiber'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            return null;
        }
        // メイン: 名前付きプロパティによる探索
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        // フォールバック: Twitch がプロパティ名を難読化した場合は構造で一致させる
        if (!player) {
            player = findReactNode(reactRootNode, node => node.getHTMLVideoElement && node.getBufferDuration && node.core?.state);
        }
        // メイン: 名前付きプロパティによる探索
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        // フォールバック: 構造で一致させる。setSrc は存在するが setInitialPlaybackSettings が改名された場合
        const playerStateFallback = !playerState ? findReactNode(reactRootNode, node => node.setSrc && node.setStreamManagerNode && !node.getHTMLVideoElement) : null;
        // フォールバック 2: TTV-AB の方式。playerMode を持つ videoPlayerInstance を使う
        const playerStateFallback2 = !playerState && !playerStateFallback ? findReactNode(reactRootNode, node => node.state?.videoPlayerInstance?.playerMode !== undefined)?.state?.videoPlayerInstance : null;
        const finalPlayerState = playerState || playerStateFallback || playerStateFallback2;
        return  {
            player: player,
            state: finalPlayerState
        };
    }
    function reloadTwitchPlayer(isPausePlay, reloadKind) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
            console.log('React のルートが見つかりません');
            return;
        }
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player) {
            console.log('プレイヤーが見つかりません');
            return;
        }
        if (!playerState) {
            console.log('プレイヤーの状態が見つかりません');
            return;
        }
        if (player.isPaused() || player.core?.paused) {
            return;
        }
        // 再読み込みのクールダウン — 直近の再読み込みから間がない場合はスキップする（CSAI の連鎖を断ち切る）。
        // 早期再読み込み（ワーカーが発動する、キャッシュが薄い場合 / フリーズからの復旧の高速経路）は
        // 判定を迂回するが記録は更新するため、短時間に 3 回以上の早期再読み込みがあれば、バッファ監視による
        // 再読み込みと同じようにクールダウンが延長される。
        if (!isPausePlay && ReloadCooldownSeconds > 0) {
            const now = Date.now();
            const cooldownMs = ReloadCooldownSeconds * 1000;
            const isEarly = reloadKind === 'early';
            if (lastReloadTimestamp && now - lastReloadTimestamp < cooldownMs) {
                if (!isEarly) {
                    console.log('[AD DEBUG] 再読み込みをスキップします — クールダウン中（残り ' + Math.round((cooldownMs - (now - lastReloadTimestamp)) / 1000) + ' 秒）');
                    return;
                }
                console.log('[AD DEBUG] 早期再読み込みのためクールダウンを迂回します（キャッシュが薄い場合の高速経路）— 本来は残り ' + Math.round((cooldownMs - (now - lastReloadTimestamp)) / 1000) + ' 秒でした');
            }
            // 自動延長: 5 分間に 3 回以上の再読み込みがあれば、クールダウンを 3 倍にする
            reloadTimestamps.push(now);
            const fiveMinAgo = now - 300000;
            while (reloadTimestamps.length > 0 && reloadTimestamps[0] < fiveMinAgo) { reloadTimestamps.shift(); }
            if (reloadTimestamps.length >= 3 && ReloadCooldownSeconds < 90) {
                EscalatedFromCooldown = ReloadCooldownSeconds;
                ReloadCooldownSeconds = 90;
                console.log('[AD DEBUG] 再読み込みのクールダウンを 90 秒に自動延長しました（5 分間に 3 回以上の再読み込み）');
            } else if (EscalatedFromCooldown !== null && reloadTimestamps.length < 3) {
                console.log('[AD DEBUG] 再読み込みのクールダウンを ' + EscalatedFromCooldown + ' 秒に戻しました（集中的な発生が収まりました）');
                ReloadCooldownSeconds = EscalatedFromCooldown;
                EscalatedFromCooldown = null;
            }
            lastReloadTimestamp = now;
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
        const lsKeyQuality = 'video-quality';
        const lsKeyMuted = 'video-muted';
        const lsKeyVolume = 'volume';
        const lsKeyLowLatency = 'lowLatencyModeEnabled';// 再読み込みをまたいでユーザーの低遅延設定を保持する（TTV-AB と同等）
        const lsKeyPersistence = 'persistenceEnabled';// 再読み込みをまたいで自動再生 / 継続の設定を保持する（TTV-AB と同等）
        let currentQualityLS = null;
        let currentMutedLS = null;
        let currentVolumeLS = null;
        let currentLowLatencyLS = null;
        let currentPersistenceLS = null;
        try {
            currentQualityLS = localStorage.getItem(lsKeyQuality);
            currentMutedLS = localStorage.getItem(lsKeyMuted);
            currentVolumeLS = localStorage.getItem(lsKeyVolume);
            currentLowLatencyLS = localStorage.getItem(lsKeyLowLatency);
            currentPersistenceLS = localStorage.getItem(lsKeyPersistence);
            if (localStorageHookFailed && player?.core?.state) {
                localStorage.setItem(lsKeyMuted, JSON.stringify({default:player.core.state.muted}));
                localStorage.setItem(lsKeyVolume, player.core.state.volume);
            }
            if (player?.core?.state?.quality?.group) {
                localStorage.setItem(lsKeyQuality, JSON.stringify({default:player.core.state.quality.group}));
            }
        } catch {}
        // ハード再読み込みの間は事前にミュートして（setSrc は必ず MSE を破棄する）、MSE の不連続の境界で
        // 生じる音声ノイズを隠す。`canplay` で復元し、1500ms で打ち切る。
        try {
            const v = document.querySelector('video');
            if (v && !v.muted) {
                v.muted = true;
                // 複数のイベントで復元する: canplay / playing / loadeddata のうち最初に発火したものを採用する。
                let done = false;
                const restore = () => {
                    if (done) return;
                    done = true;
                    document.removeEventListener('canplay', listener, true);
                    document.removeEventListener('playing', listener, true);
                    document.removeEventListener('loadeddata', listener, true);
                    try {
                        const cur = document.querySelector('video');
                        if (cur) cur.muted = false;
                    } catch {}
                };
                const listener = (e) => {
                    if (e.target && e.target.tagName === 'VIDEO') restore();
                };
                document.addEventListener('canplay', listener, true);
                document.addEventListener('playing', listener, true);
                document.addEventListener('loadeddata', listener, true);
                setTimeout(restore, 4000);// Edge の初期化の遅さに余裕を持たせるため 2500ms → 4000ms に引き上げた。
            }
        } catch {}
        playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
        player.play()?.catch?.(() => {});
        // 再読み込み後は必ずミュート / 音量の状態を復元する。Chrome の自動再生ポリシーによって強制的にミュートされることがあるため。
        // このブロックは常に実行する必要がある: Twitch がまだ LS に値を書き込んでいない場合（新規セッション、プライベートモード、
        // キャッシュ削除後）でも、再読み込み時に Chrome の自動再生ミュートが働くため、動画のミュート解除が必要になる。
        {
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
                    if (currentLowLatencyLS !== null) {
                        localStorage.setItem(lsKeyLowLatency, currentLowLatencyLS);
                    }
                    if (currentPersistenceLS !== null) {
                        localStorage.setItem(lsKeyPersistence, currentPersistenceLS);
                    }
                    const videos = document.getElementsByTagName('video');
                    // ユーザーのミュート意図を尊重する: LS がミュートを示していない場合のみ強制的にミュートを解除する。
                    // ユーザーが UI からミュートした場合、Twitch は video-muted に '{"default":true}' を書き込む。
                    // Chrome の自動再生ポリシーは、ユーザーが操作していなくてもミュートすることがある（LS には何も残らない）。
                    const userIntendedMute = currentMutedLS && currentMutedLS.includes('"default":true');
                    if (videos.length > 0 && videos[0].muted && !userIntendedMute) {
                        videos[0].muted = false;
                    }
                } catch {}
            }, 3000);
        }
    }
    function onContentLoaded() {
        if (document.getElementById('seventv-extension')) {
            console.log('[AD DEBUG] 警告: 7TV 拡張機能を検出しました — 黒画面やバッファリングの原因になることがあります。問題が起きる場合は 7TV を無効にしてみてください。');
        }
        // 非表示のタブで広告中に Twitch がプレイヤーを一時停止した場合、タブにフォーカスが戻ったら再開する。
        // 以前は document.hidden / visibilityState / hasFocus / mozHidden / webkitHidden も偽装し、
        // キャプチャフェーズでイベントを握りつぶしていた。しかしそれは実際の可視状態に依存する
        // 他の拡張機能（BetterTTV の「Mute Invisible Player」など）を壊していた。広告中の
        // 非表示→表示の遷移で再生を維持するには、フォーカス時の再開だけで十分である。
        // TTV-AB v6.5.0 と同期。
        let wasVideoPlaying = true;
        const visibilityChange = () => {
            const videos = document.getElementsByTagName('video');
            if (videos.length === 0) return;
            if (document.hidden) {
                wasVideoPlaying = !videos[0].paused && !videos[0].ended;
                return;
            }
            if (wasVideoPlaying && !videos[0].ended && videos[0].paused) {
                videos[0].play()?.catch?.(() => {});
            }
        };
        document.addEventListener('visibilitychange', visibilityChange);
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
            localStorage.setItem = maskAsNative(function(key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            }, 'setItem');
            const realGetItem = localStorage.getItem;
            localStorage.getItem = maskAsNative(function(key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            }, 'getItem');
            if (localStorage.getItem === realGetItem) {
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
    declareOptions(window);
    try {
        const lsReloadAfterAd = localStorage.getItem('twitchAdSolutions_reloadPlayerAfterAd');
        if (lsReloadAfterAd !== null) {
            ReloadPlayerAfterAd = lsReloadAfterAd === 'true';
        }
        const lsPlayerType = localStorage.getItem('twitchAdSolutions_playerType');
        if (lsPlayerType !== null) {
            OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE = lsPlayerType;
        }
        const lsPinBackup = localStorage.getItem('twitchAdSolutions_pinBackupPlayerType');
        if (lsPinBackup !== null) {
            PinBackupPlayerType = lsPinBackup === 'true';
        }
        const lsCooldown = parseInt(localStorage.getItem('twitchAdSolutions_reloadCooldownSeconds'));
        if (!isNaN(lsCooldown) && lsCooldown >= 0) {
            ReloadCooldownSeconds = lsCooldown;
        }
        const lsEarlyReload = parseInt(localStorage.getItem('twitchAdSolutions_earlyReloadPollThreshold'));
        if (!isNaN(lsEarlyReload) && lsEarlyReload >= 0) {
            EarlyReloadPollThreshold = lsEarlyReload;
        }
        const lsHideAdOverlay = localStorage.getItem('twitchAdSolutions_hideAdOverlay');
        if (lsHideAdOverlay === 'true') {
            const style = document.createElement('style');
            style.textContent = '.tas-adblock-overlay { display: none !important; }';
            (document.head || document.documentElement).appendChild(style);
        }
    } catch {}
    console.log('[AD DEBUG] 設定: ReloadPlayerAfterAd = ' + ReloadPlayerAfterAd + ', ForceAccessTokenPlayerType = ' + OPT_FORCE_ACCESS_TOKEN_PLAYER_TYPE + ', PinBackupPlayerType = ' + PinBackupPlayerType);
    hookWindowWorker();
    hookFetch();
    const realXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = maskAsNative(function(method, url) {
        if (typeof url === 'string' && url.includes('edge.ads.twitch.tv')) {
            const csaiType = url.includes('bp=midroll') ? 'midroll' : url.includes('bp=preroll') ? 'preroll' : 'unknown';
            const xhrKey = csaiType + '-xhr';
            if (!loggedCsaiTypes.has(xhrKey)) {
                loggedCsaiTypes.add(xhrKey);
                console.log('[AD DEBUG] CSAI の広告リクエスト（XHR）を検出 — 種別: ' + csaiType);
            }
        }
        return realXHROpen.apply(this, arguments);
    }, 'open');
    monitorLiveStatus();
    if (document.readyState === "complete" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function() {
            onContentLoaded();
        });
    }
    window.simulateAds = (depth) => {
        if (depth === undefined || depth < 0) {
            console.log('広告の深さのパラメータが必要です（0 = 模擬広告なし、1 以上 = 指定した深さでバックアップのプレイヤーを使用）');
            return;
        }
        postTwitchWorkerMessage('SimulateAds', depth);
    };
    window.allSegmentsAreAdSegments = () => {
        postTwitchWorkerMessage('AllSegmentsAreAdSegments');
    };
})();