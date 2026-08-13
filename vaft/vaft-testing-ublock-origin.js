twitch-videoad.js text/javascript
(function() {
    if ( /(^|\.)twitch\.tv$/.test(document.location.hostname) === false ) { return; }
    // 正規の Twitch 埋め込みコンテキストではない入れ子のフレームには注入しない。
    // Twitch のチャンネルページには 5 つ以上の非表示のクロスオリジン iframe（認証、解析、広告 SDK など）があり、
    // uBO は条件に一致するすべてに注入する。その一つひとつが競合する vaft のインスタンスになり、
    // プレイヤーの制御を奪い合ってしまう。twitch.tv/CHANNEL でプレイヤーを持つのは最上位フレームだけで、
    // 入れ子の補助フレームはノイズである。
    // 入れ子フレームへの注入を許可するリスト: Twitch が文書化している 3 つの埋め込みコンテキスト
    // （https://dev.twitch.tv/docs/embed/video-and-clips/）。これにより、親が別オリジンの iframe 内で
    // vaft が動作するサードパーティサイト上の Twitch 配信の埋め込みが維持される。
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
            console.log('[AD DEBUG] vaft-testing をスキップしました — ' + _host + document.location.pathname + ' の入れ子フレームです（Twitch の埋め込みではありません）。twitch.tv/CHANNEL の最上位フレームでこれが表示される場合は報告してください。');
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
            console.log('[AD DEBUG] vaft-testing をスキップしました — クリップエディタのページです（' + _clipHost + _clipPath + '）。');
            return;
        }
    }
    'use strict';
    const ourTwitchAdSolutionsVersion = 671;// 古いバージョンのスクリプトとの競合を防ぐために使う
    console.log('[AD DEBUG] TwitchAdSolutions vaft-testing v' + ourTwitchAdSolutionsVersion + ' を読み込んでいます');
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log('[AD DEBUG] 競合: vaft-testing v' + ourTwitchAdSolutionsVersion + ' をスキップしました — 別のスクリプトがすでに有効です（v' + window.twitchAdSolutionsVersion + '）。重複するスクリプトを削除してください。');
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    // window スコープとワーカースコープの間で共有する設定と状態
    function declareOptions(scope) {
        // 'twitch-stitched' は twitch-stitched-* の DATERANGE クラス群（-ad、-mid、-pod など）を、
        // 正確な -ad 接尾辞を要求せずに捕捉する。twitch- の接頭辞を付けることで、
        // 素の 'stitched' の部分一致による PR #120 の誤検出を再発させない。
        // 具体的な twitch-stitched-ad の DATERANGE マーカーはこの接頭辞の部分集合である。
        scope.AdSignifiers = ['stitched-ad', 'EXT-X-CUE-OUT', 'twitch-stitched', 'EXT-X-DATERANGE:CLASS="twitch-maf-ad"', 'EXT-X-DATERANGE:CLASS="twitch-trigger"'];// テストでの長時間検証のために twitch-trigger を追加した — 理由は vaft_testing.user.js を参照。
        // セッション / ソースのメタデータであることが確認済みで広告マーカーではない。候補のログから除外する。
        scope.KnownNonAdSignifiers = ['twitch-session', 'twitch-stream-source', 'twitch-ad-quartile', 'twitch-assignment'];
        scope.AdSegmentURLPatterns = ['/adsquared/', '/_404/', '/processing'];
        // stripAdSegments のホットパスで共有するコンパイル済みの正規表現。ここで宣言し
        // （declareOptions によってワーカーの blob にシリアライズされる）、行ごとの除去ループ内の
        // リテラルが毎回再コンパイルされないようにする。
        scope.TwitchAdUrlRewriteRegex = /(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g;
        scope.UriAttributeRegex = /URI="([^"]+)"/;
        scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = [
            // 順序が重要: 最初にクリーンだったタイプを採用する。'embed' は末尾に移動した。twitch.tv オリジンから
            // embed の streamPlaybackAccessToken を要求すると Twitch が GQL の 'server error' を返すことが実地で確認されており、
            // 最初に試すと広告のたびに 200〜400ms を無駄にするため。チャンネルとユーザーの組み合わせによっては
            // 成功する可能性があるので残してある。
            'site',//Source
            'popout',//Source
            'mobile_web',// モバイル
            'embed',// Source（信頼性が低い — 上の注記を参照）
            // 'autoplay'（360p）は除外した: 巡回のバックアップとして採用されると、CSAI のみの経路が
            // バックアップを解放した後にプレイヤーがローディング表示から抜けられなくなる。
            // autoplay のバリアントはメインストリームのバリアントへきれいに遷移しないため。
        ];
        scope.FallbackPlayerType = 'site';// 以前は 'embed' だった — すべての Source タイプが広告入りになる場合は site の方が確実である
        scope.ForceAccessTokenPlayerType = 'popout';
        scope.PreferLowQualityBackup = true;// SSAI が多い広告向けのハイブリッドな安全策: スティッキーな脱出処理（全セグメント除去の状態が約 8 秒続くと発動）と、すべての Source タイプが広告入りのときの最終手段としての autoplay（360p）のバックアップ。デフォルトで有効。無効にするには twitchAdSolutions_preferLowQualityBackup=false を設定する。
        scope.FastAutoplayFirstTry = true;// 前回の広告で Source 帯を使い切っていた場合は autoplay を先頭に置く。v638 以降はデフォルトで有効。無効化: twitchAdSolutions_fastAutoplayFirstTry=false。
        scope.BackupSwapFirst = true;// 広告を検出したら、すぐにバックアップのプレイヤータイプの m3u8 に切り替える（TTV-AB 方式）。除去処理による MediaSource の混在を避けられ、実地ではローディング表示が減る。代償として広告のたびに追加の取得が発生する。デフォルトで有効。無効にするには twitchAdSolutions_backupSwapFirst=false を設定する。
        scope.RecoverFromSilentMute = true;// issue #200: ハード再読み込みの際、Twitch による静かな再ミュートから復旧する。デフォルトで有効。無効にするには twitchAdSolutions_recoverFromSilentMute=false を設定する。
        scope.SoftReloadNoStrip = true;// issue #129（モード D）: 広告でセグメントが 1 つも除去されなかった場合（BackupSwapFirst による CSAI の切り替え）、広告後の再読み込みにソフト再読み込みを使う。ハード再読み込みによる MediaSource のフラッシュが必要なのは除去による注入（BLANK_MP4 / 復旧）の後だけで、除去のない広告では、デスクトップでの黒画面 + 再生アイコンを伴う破棄のコストを無駄に払うことになる。デフォルトで有効。常にハードだった従来の挙動に戻すには twitchAdSolutions_softReloadNoStrip=false を設定する。
        scope.DisableInAdGapSeek = false;// 広告中の、空白でフリーズした場合のシーク（TTV-AB #33 に準拠）。デフォルトで有効。無効にするには twitchAdSolutions_disableInAdGapSeek=true を設定する（広告途中の一時停止 / ローディング表示の報告を切り分ける A/B 検証用）。
        scope.DisableInAdFreezeReload = false;// 広告中の再生位置フリーズに対する再読み込みへの段階的移行 — シークでは捕捉できない音声側の空白による CSAI のフリーズ（約 60 秒の停止が観測されている）に対する、readyState に依存しない最終防衛線。デフォルトで有効。無効にするには twitchAdSolutions_disableInAdFreezeReload=true を設定する。
        scope.DisablePostBreakWedge = false;// 広告終了後の映像の詰まりからの復旧（GosuDRM/TTV-AB の _checkPostBreakWedge、v12.0.0 に準拠）。広告の後の「音声は流れているのに映像がフリーズする」状態（再生位置は進むのにデコーダーが新しいフレームを出さない状態）を、currentTime を基準にしたフリーズ判定では見えない getVideoPlaybackQuality().totalVideoFrames によって検出する。デフォルトで有効。無効にするには twitchAdSolutions_disablePostBreakWedge=true を設定する。
        scope.SkipPlayerReloadOnHevc = false;// true にすると 2K / 4K の画質があるストリームでプレイヤーの再読み込みを省略する（これを有効にしたうえで 2K / 4K の画質設定を使うと、Chromium 系のブラウザでエラー #4000 / #3000 や読み込み中の回転表示が発生する）
        scope.AlwaysReloadPlayerOnAd = false;// 広告の開始時と終了時に必ず一時停止 / 再生を行う
        scope.ReloadPlayerAfterAd = true;// 広告の終了後、一時停止 / 再生ではなくプレイヤーの再読み込みを行う
        scope.ReloadCooldownSeconds = 30;// 再読み込みの最小間隔（秒）— 再読み込みが引き金となる CSAI の連鎖を断ち切る
        scope.DisableReloadCap = false;// true にすると、バッファ監視が無制限に再読み込みを行う（v47 以前の挙動。連鎖のリスクあり）
        scope.DriftCorrectionRate = 1.1;// 再読み込み後にライブ端へ追いつくための再生速度（0 でドリフト補正を無効化）
        scope.EarlyReloadPollThreshold = 3;// 早期再読み込みを発動するまでの、全セグメント除去のポーリングの連続回数（1 回あたり約 2 秒なので 3 で約 6 秒、5 で約 10 秒、10 で約 20 秒。0 で無効）
        scope.DisableAdSpoofing = true;// デフォルトで無効: スプーフのビーコンが示す「常に 100% 視聴・音声あり・表示中」というパターン自体が異常として特徴づけられ、検出の強化（より多くの帯での CSAI）を招く可能性がある。GQL の広告トラッキングのビーコン（notifyAdComplete）を送るには twitchAdSolutions_disableAdSpoofing=false を設定してオプトインする。v68.2.0 まではデフォルトで有効だった。
        scope.PinBackupPlayerType = true;// 成功したバックアップのプレイヤータイプを記憶し、次回の広告で最初に試す
        scope.PlayerReloadMinimalRequestsTime = 1500;
        scope.PlayerReloadMinimalRequestsPlayerIndex = 2;//autoplay
        scope.HasTriggeredPlayerReload = false;
        scope.StreamInfos = [];
        scope.StreamInfosByUrl = [];
        scope.GQLDeviceID = null;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.PlayerBufferingFix = true;// true にすると、バッファリングで固まったときにプレイヤーの一時停止 / 再生を行う
        scope.PlayerBufferingDelay = 600;// プレイヤーの状態を確認する間隔（ミリ秒）
        scope.PlayerBufferingSameStateCount = 3;// 同じプレイヤーの状態を何回観測したら一時停止 / 再生を発動するか（プレイヤーの状態が再び変わるまで 1 回しか発動しない）
        scope.PlayerBufferingDangerZone = 0.5;// 1 → 0.5 に引き下げた: ライブ端で薄いながらも機能しているバッファのときに連鎖的に発動するのを避けるため。
        scope.PlayerBufferingDoPlayerReload = false;// true にすると、一時停止 / 再生の代わりにプレイヤーの再読み込みを行う（再読み込みの方が再生の問題をよく解消するが、少し時間がかかる）
        scope.PlayerBufferingMinRepeatDelay = 8000;// 一時停止 / 再生の最小間隔（ミリ秒）（本当にバッファリングの問題があるときに一時停止 / 再生を連打しないようにするため）
        scope.PlayerBufferingPrerollCheckEnabled = false;// ストリームを開いた直後に一時停止 / 再生 / 再読み込みが起きる場合（読み込みが遅くなる原因になる）は有効にする。true にすることの問題として、場合によってはプレイヤーが固まり、ユーザーが一時停止 / 再生を押す必要が生じることがある
        scope.PlayerBufferingPrerollCheckOffset = 5;// バッファリング対策を行うまでにストリームがどれだけ進む必要があるか（PlayerBufferingPrerollCheckEnabled が true であることが前提）
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
    }
    function maskAsNative(fn, name) {
        fn.toString = () => 'function ' + name + '() { [native code] }';
        return fn;
    }
    // すべてのフィールドの形状を最初に宣言した新しい StreamInfo を生成する。ワーカーのコードの
    // どこかで読み書きされるフィールドはすべてここで初期化すべきである。そうすれば、新しい
    // フィールドがコード各所で場当たり的に代入されて形状が崩れていくのを避け、全体像を 1 か所で
    // 把握できる。streamInfo に新しいフィールドを追加するときは、まずここで適切な初期値とともに
    // 宣言し、その上で必要なコード経路から代入すること。
    function createStreamInfo(channelName, encodingsM3u8, usherParams) {
        return {
            // 識別情報
            ChannelName: channelName,
            EncodingsM3U8: encodingsM3u8,
            UsherParams: usherParams,
            // 解像度 / URL のマップ
            Urls: [],// xxx.m3u8 -> { Resolution: "284x160", FrameRate: 30.0 }
            ResolutionList: [],
            RequestedAds: new Set(),
            SpoofedAdIds: new Set(),// notifyAdComplete の複数ポーリングにまたがる重複排除 — 広告の終了時にクリアされる。
            // 変更済み m3u8 の状態
            ModifiedM3U8: null,
            IsUsingModifiedM3U8: false,
            // 広告の状態
            IsShowingAd: false,
            IsMidroll: false,
            AdBreakStartedAt: 0,
            PodLength: 1,
            CleanPlaylistCount: 0,
            PendingAdEndAt: 0,
            AdEndBounceCount: 0,
            ConsecutiveZeroStripBreaks: 0,
            SawCSAIFastPath: false,
            // 除去処理の状態
            IsStrippingAdSegments: false,
            NumStrippedAdSegments: 0,
            RecoverySegments: [],
            RecoveryStartSeq: undefined,// 重要: 復旧の注入箇所で `!== undefined` により明示的に判定している。0 ではなく undefined のままにしておくこと。
            FreezeStartedAt: 0,
            ConsecutiveAllStrippedPolls: 0,
            TotalAllStrippedPolls: 0,
            LastCleanNativeM3U8: null,// 全セグメントが除去された場合の復旧のために、広告のないポーリング時にキャッシュしたプレイリスト全体のスナップショット（TTV-AB に準拠）
            LastCleanNativePlaylistAt: 0,
            // バックアップのプレイヤータイプの巡回
            BackupEncodingsM3U8Cache: [],
            ActiveBackupPlayerType: null,
            PinnedBackupPlayerType: null,
            LastCommittedBackupPlayerType: null,
            FailedBackupPlayerTypes: new Map(),// Map<playerType, timestamp> — 失敗は 15 秒で期限切れになり再試行できる
            LoggedBackupAdsByType: null,// 最初の「バックアップに広告あり」のログで Set を遅延生成する
            CycleRescuedThisBreak: false,
            LastBackupSwitch: 0,
            // 早期再読み込み
            EarlyReloadCount: 0,
            EarlyReloadAtPoll: 0,
            EarlyReloadTriggered: false,
            EarlyReloadAwaitingResult: false,
            EscapeHatchFired: false,
            LastBreakUsedEscapeHatch: false,
            FastAutoplayConsecutive: 0,// 再探索のカウンター — 定期的に Source 帯を完全に探索し、チャンネルの回復を検出する。
            // 再読み込みのクールダウン
            LastPlayerReload: 0,
            ReloadTimestamps: [],
            // 広告セグメントのキャッシュの間引き（PR #121）
            LastAdCachePruneAt: 0,
            LoggedAdCacheSize1k: false,
            // 診断用フラグ（セッションごとに 1 回）
            HasCheckedUnknownTags: false,
            HasLoggedAdAttributes: false,
            HasLoggedUnknownSignifiers: false,
            LoggedOfflineTransition: false,
            ConsecutiveTokenFetchFailures: 0,
            LoggedTokenFailureStreak: false,
        };
    }
    const loggedCsaiTypes = new Set();
    let isActivelyStrippingAds = false;
    let localStorageHookFailed = false;
    const twitchWorkers = [];
    let cachedRootNode = null;// キャッシュした #root の DOM 要素（React の SPA では変化しない）
    let cachedPlayerRootDiv = null;// キャッシュした .video-player の要素
    // オーバーレイ非表示ログの単発フラグ。Twitch の React ツリーは広告中に SDA の
    // ラッパーや広告カードを絶えず再マウントするため、非表示処理とログが数百回実行される。
    // ページ読み込みごとに、非表示の種類ごとの初回だけをログに出し、以降は黙る。
    // 非表示の処理自体は dataset による重複排除によって毎ティック実行され続ける。
    let loggedSdaHide = false;
    // 競合する Twitch ワーカーの上書き（TwitchNoSub など）を検出・処理するための文字列
    const workerStringConflicts = [
        'twitch',
        'isVariantA'// TwitchNoSub
    ];
    const workerStringReinsert = [
        'isVariantA',// TwitchNoSub (prior to (0.9))
        'besuper/',// TwitchNoSub (0.9)
        '${patch_url}'// TwitchNoSub (0.9.1)
    ];
    // Worker のプロトタイプチェーンをたどり、競合する上書きを除去する
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x))) {
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
        const hasReinsert = workerStringReinsert.some((x) => workerString.includes(x));
        if (hasConflict && !hasReinsert) {
            console.log('[AD DEBUG] ワーカーを拒否しました — 競合する文字列を検出: ' + workerStringConflicts.filter((x) => workerString.includes(x)).join(', '));
        }
        return !hasConflict || hasReinsert;
    }
    // window.Worker を置き換えて Twitch の動画ワーカーを横取りし、広告ブロックのロジックを注入する
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
                    ${notifyAdComplete.toString()}
                    ${getMatchedAdSignifiers.toString()}
                    ${stripAdSegments.toString()}
                    ${getStreamUrlForResolution.toString()}
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getAccessToken.toString()}
                    ${gqlRequest.toString()}
                    ${parseAttributes.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    ${createStreamInfo.toString()}
                    const workerString = getWasmWorkerJs('${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
                    ReloadPlayerAfterAd = ${ReloadPlayerAfterAd};
                    ReloadCooldownSeconds = ${ReloadCooldownSeconds};
                    DisableReloadCap = ${DisableReloadCap};
                    PinBackupPlayerType = ${PinBackupPlayerType};
                    EarlyReloadPollThreshold = ${EarlyReloadPollThreshold};
                    PreferLowQualityBackup = ${PreferLowQualityBackup};
                    FastAutoplayFirstTry = ${FastAutoplayFirstTry};
                    BackupSwapFirst = ${BackupSwapFirst};
                    DisableAdSpoofing = ${DisableAdSpoofing};
                    SoftReloadNoStrip = ${SoftReloadNoStrip};
                    ForceAccessTokenPlayerType = '${ForceAccessTokenPlayerType}';
                    GQLDeviceID = ${GQLDeviceID ? "'" + GQLDeviceID + "'" : null};
                    AuthorizationHeader = ${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = ${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    ClientVersion = ${ClientVersion ? "'" + ClientVersion + "'" : null};
                    ClientSession = ${ClientSession ? "'" + ClientSession + "'" : null};
                    self.addEventListener('message', function(e) {
                        if (e.data.key == 'UpdateClientVersion') {
                            ClientVersion = e.data.value;
                        } else if (e.data.key == 'UpdateClientSession') {
                            ClientSession = e.data.value;
                        } else if (e.data.key == 'UpdateClientId') {
                            ClientID = e.data.value;
                        } else if (e.data.key == 'UpdateDeviceId') {
                            GQLDeviceID = e.data.value;
                        } else if (e.data.key == 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key == 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key == 'FetchResponse') {
                            const responseData = e.data.value;
                            if (pendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject } = pendingFetchRequests.get(responseData.id);
                                pendingFetchRequests.delete(responseData.id);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    // レスポンスデータから Response オブジェクトを生成する。
                                    // Response のコンストラクタは status / statusText / headers しか受け取らないため、url / redirected / type は
                                    // インスタンス側で定義する必要がある。IVS の WASM はこれらを検証しており（Spade / トラッキングの
                                    // リクエスト）、欠けていると NetworkError を投げる。TTV-AB v6.3.5 の修正。
                                    // ボディを持てないステータス（101 / 204 / 205 / 304）に null でないボディを渡すと
                                    // Response のコンストラクタが例外を投げる。ここで中継される 304 / 204 は null ではなく
                                    // 空文字列（''）のボディを持つため、例外となって中継中の fetch が止まってしまう。
                                    // これらのステータスではボディを捨てる。
                                    // GosuDRM/TTV-AB v9.7.1 / v9.9.0 に準拠。
                                    const _nullBodyStatus = responseData.status === 101 || responseData.status === 204 || responseData.status === 205 || responseData.status === 304;
                                    const response = new Response(_nullBodyStatus ? null : responseData.body, {
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
                        } else if (e.data.key == 'TriggeredPlayerReload') {
                            HasTriggeredPlayerReload = true;
                        } else if (e.data.key == 'ReloadSkipped') {
                            // メインスレッドが再読み込みを拒否した場合（プレイヤーが正常）は、早期再読み込みのフラグをクリアし、
                            // 後でプレイヤーが停止したときに再度発動できるようにする
                            let cleared = false;
                            for (const channel in StreamInfos) {
                                const si = StreamInfos[channel];
                                if (si && si.EarlyReloadTriggered) {
                                    si.EarlyReloadTriggered = false;
                                    si.EarlyReloadAwaitingResult = false;
                                    si.EarlyReloadCount = Math.max(0, (si.EarlyReloadCount || 0) - 1);
                                    cleared = true;
                                }
                            }
                            if (cleared) {
                                console.log('[AD DEBUG] メインスレッドが再読み込みをスキップしました（プレイヤーは正常）— 早期再読み込みの状態をクリアし、再試行できます');
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
                `;
                if (injectedBlobUrl && originalRevokeObjectURL) {
                    try { originalRevokeObjectURL.call(URL, injectedBlobUrl); } catch {}
                }
                injectedBlobUrl = URL.createObjectURL(new Blob([newBlobStr]));
                super(injectedBlobUrl, options);
                twitchWorkers.length = 0;
                twitchWorkers.push(this);
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'UpdateAdBlockBanner') {
                        updateAdblockBanner(e.data);
                        // バックアップストリームの切り替え（広告の開始と終了）を追跡する
                        if (e.data.hasAds !== !!playerBufferState.inAdBreak) {
                            playerBufferState.lastBackupSwitchAt = Date.now();
                            // 広告終了時に位置の追跡をリセットし、ストリーム切り替えによる空白を位置飛びとして検出しないようにする
                            if (!e.data.hasAds) {
                                playerBufferState.position = 0;
                            }
                        }
                        playerBufferState.inAdBreak = !!e.data.hasAds;
                        // 広告が始まったらドリフトの追いつき処理をクリアする。広告処理中に 1.1 倍速で再生しない
                        if (e.data.hasAds && (driftCatchUpInterval || driftCatchUpTimeout)) {
                            if (driftCatchUpInterval) { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
                            if (driftCatchUpTimeout) { clearTimeout(driftCatchUpTimeout); driftCatchUpTimeout = null; }
                            try { document.querySelector('video').playbackRate = 1.0; } catch {}
                        }
                    } else if (e.data.key == 'PauseResumePlayer') {
                        doTwitchPlayerTask(true, false);
                    } else if (e.data.key == 'ReloadPlayer') {
                        doTwitchPlayerTask(false, true, e.data.kind);
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
                // ワーカーのクラッシュからの復旧 — Amazon IVS の WASM ワーカーは RuntimeError
                // （"indirect call signature mismatch"、"index out of bounds" など）を投げて停止することがある。
                // vaft が原因ではなく（Amazon がコンパイルした WASM の内部で発生する）、復旧は可能である。
                // ハード再読み込みを行えば Twitch が新しいプレイヤーインスタンスでワーカーを再生成する。
                // 1 回のクラッシュで複数の error イベントが発生するため、ワーカーごとの `crashed` フラグで
                // 重複を排除する。
                // サーキットブレーカー: このフラグは再読み込みをまたいで残らない（新しいワーカー = 新しいフラグ）。
                // さらにこの経路は doTwitchPlayerTask を直接呼び、ワーカー側の再読み込みクールダウンを迂回する。
                // そのため、WASM が繰り返しクラッシュする状態（コーデックやストリームの状態が不正）では、
                // クールダウンのない密なクラッシュ→再読み込み→クラッシュのループになり、クラッシュ自体より
                // 悪化してしまう。playerBufferState は再読み込みをまたいで残るので、60 秒の移動ウィンドウで
                // クラッシュの時刻を記録し、3 回以上になったら自動再読み込みを止める（再読み込みでは明らかに
                // 解決していないため、あとはユーザーの判断に委ねる）。自己回復もする: 静かな期間が続けば
                // ウィンドウは空になるので、時間をおいて単発のクラッシュが起きた場合は再び復旧できる。
                let crashed = false;
                this.addEventListener('error', (e) => {
                    if (crashed) return;
                    crashed = true;
                    const now = Date.now();
                    const crashTimes = (playerBufferState.ivsCrashTimes = (playerBufferState.ivsCrashTimes || []).filter(t => now - t < 60000));
                    crashTimes.push(now);
                    const msg = (e && e.message) || 'unknown error';
                    if (crashTimes.length >= 3) {
                        console.log('[AD DEBUG] IVS の WASM ワーカーがクラッシュしました: ' + msg + ' — 60 秒間に ' + crashTimes.length + ' 回のクラッシュ。自動復旧を停止します（Amazon IVS 側の不安定さであり、再読み込みでは解消していません）');
                        return;
                    }
                    console.log('[AD DEBUG] IVS の WASM ワーカーがクラッシュしました: ' + msg + ' — 復旧のためハード再読み込みを行います（60 秒間に ' + crashTimes.length + '/3 回）');
                    try { doTwitchPlayerTask(false, true, 'early'); } catch (err) {
                        console.log('[AD DEBUG] ワーカーのクラッシュからの復旧に失敗しました: ' + err.message);
                    }
                });
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
    // ワーカースコープで fetch() をフックし、m3u8 プレイリストのリクエストと広告セグメントを横取りする
    function hookWorkerFetch() {
        console.log('[AD DEBUG] hookWorkerFetch (vaft)');
        const BLANK_MP4 = new Blob([Uint8Array.from(atob('AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA'), c => c.charCodeAt(0))], {type: 'video/mp4'});
        const realFetch = fetch;
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                if (AdSegmentCache.has(url)) {
                    return new Response(BLANK_MP4);
                }
                url = url.trimEnd();
                if (url.endsWith('m3u8')) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                resolve(new Response(await processM3U8(url, await response.text(), realFetch)));
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
                    const parsedUrl = new URL(url);
                    const channelName = parsedUrl.pathname.match(/([^\/]+)(?=\.\w+$)/)?.[0];
                    if (ForceAccessTokenPlayerType) {
                        // parent_domains はプレイヤーが埋め込みかどうかの判定に使われるため、これを除去すると偽の広告がなくなる
                        parsedUrl.searchParams.delete('parent_domains');
                        url = parsedUrl.toString();
                    }
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status == 200) {
                                const encodingsM3u8 = await response.text();
                                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                let streamInfo = StreamInfos[channelName];
                                if (streamInfo != null && streamInfo.EncodingsM3U8 != null && (await realFetch(streamInfo.EncodingsM3U8.match(/^https:.*\.m3u8$/m)?.[0])).status !== 200) {
                                    // キャッシュしていた encodings が無効になっている（おそらく配信が再開された）
                                    streamInfo = null;
                                }
                                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                    console.log('[AD DEBUG] 新しいストリームセッション — チャンネル: ' + channelName + '、API: ' + (V2API ? 'v2' : 'v1'));
                                    StreamInfos[channelName] = streamInfo = createStreamInfo(channelName, encodingsM3u8, parsedUrl.search);
                                    const lines = encodingsM3u8.split(/\r?\n/);
                                    for (let i = 0; i < lines.length - 1; i++) {
                                        // v2 API の URL 形式（'.m3u8' を含まない生の CDN URL）も受け入れる。
                                        const nextLine = lines[i + 1]?.trim();
                                        if (lines[i].startsWith('#EXT-X-STREAM-INF') && nextLine && !nextLine.startsWith('#') && (nextLine.includes('.m3u8') || nextLine.includes('://'))) {
                                            const attributes = parseAttributes(lines[i]);
                                            const resolution = attributes['RESOLUTION'];
                                            if (resolution) {
                                                const resolutionInfo = {
                                                    Resolution: resolution,
                                                    FrameRate: attributes['FRAME-RATE'],
                                                    Codecs: attributes['CODECS'],
                                                    Audio: attributes['AUDIO'] || '',
                                                    Video: attributes['VIDEO'] || '',
                                                    Subtitles: attributes['SUBTITLES'] || '',
                                                    Url: lines[i + 1]
                                                };
                                                streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                                                streamInfo.ResolutionList.push(resolutionInfo);
                                            }
                                            StreamInfosByUrl[lines[i + 1]] = streamInfo;
                                        }
                                    }
                                    if (streamInfo.ResolutionList.length === 0) {
                                        console.log('[AD DEBUG] encodings の m3u8 から解像度を解析できませんでした — Twitch が形式を変更した可能性があります');
                                    }
                                    // コーデック的に安全な切り替え先の候補は AVC（H.264）のみ。TTV-AB v12.0.9 の
                                    // parser.ts _isEnhancedCodecString に準拠: AV1（'av0*'）は「enhanced」コーデックであり、
                                    // 一部のブラウザ / ハードウェアでは HEVC とまったく同様に広告の間ずっと黒画面になることがある
                                    // （GosuDRM/TTV-AB #47）。したがって AV1 を切り替え先にしてはならない。ストリームに AVC が
                                    // まったく含まれない場合（enhanced のみ）、このリストは空になり、下の切り替えは単に発火しない。
                                    // その場合はストリームに手を加えず、TTV-AB の all-enhanced 時のショートサーキットと同じ挙動になる。
                                    const decodableResolutionList = streamInfo.ResolutionList.filter((element) => element.Codecs.startsWith('avc'));
                                    // enhanced のバリアント（HEVC または AV1）が 1 つでも存在し、かつデコード可能な（AVC の）切り替え先が
                                    // ある場合に発火する。ここに av0 を加えたことで、以前は切り替えが一度も発火せず AV1 のまま
                                    // 広告の黒画面に突入していたネイティブ AV1 のストリームが修正された。
                                    if (AlwaysReloadPlayerOnAd || (decodableResolutionList.length > 0 && streamInfo.ResolutionList.some((element) => element.Codecs.startsWith('hev') || element.Codecs.startsWith('hvc') || element.Codecs.startsWith('av0')) && !SkipPlayerReloadOnHevc)) {
                                        const replaceOrAppendStreamInfAttr = (line, key, value) => {
                                            if (typeof value !== 'string' || !value) return line;
                                            const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                                            const next = key + '="' + escaped + '"';
                                            const pattern = new RegExp('(^|,)' + key + '=("[^"]*"|[^,]*)');
                                            return pattern.test(line) ? line.replace(pattern, '$1' + next) : line + ',' + next;
                                        };
                                        if (decodableResolutionList.length > 0) {
                                            for (let i = 0; i < lines.length - 1; i++) {
                                                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                                    const resSettings = parseAttributes(lines[i].substring(lines[i].indexOf(':') + 1));
                                                    const codecsKey = 'CODECS';
                                                    if (resSettings[codecsKey].startsWith('hev') || resSettings[codecsKey].startsWith('hvc') || resSettings[codecsKey].startsWith('av0')) {
                                                        const oldResolution = resSettings['RESOLUTION'];
                                                        const [targetWidth, targetHeight] = oldResolution.split('x').map(Number);
                                                        const newResolutionInfo = decodableResolutionList.sort((a, b) => {
                                                            // TODO: 並べ替えの際に 'Frame-Rate' も考慮する（1080p60 と 1080p30 など）
                                                            const [streamWidthA, streamHeightA] = a.Resolution.split('x').map(Number);
                                                            const [streamWidthB, streamHeightB] = b.Resolution.split('x').map(Number);
                                                            return Math.abs((streamWidthA * streamHeightA) - (targetWidth * targetHeight)) - Math.abs((streamWidthB * streamHeightB) - (targetWidth * targetHeight));
                                                        })[0];
                                                        console.log('ModifiedM3U8 の切り替え ' + resSettings[codecsKey] + ' → ' + newResolutionInfo.Codecs + ' 旧解像度:' + oldResolution + ' 新解像度:' + newResolutionInfo.Resolution);
                                                        lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${newResolutionInfo.Codecs}"`);
                                                        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'AUDIO', newResolutionInfo.Audio);
                                                        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'VIDEO', newResolutionInfo.Video);
                                                        lines[i] = replaceOrAppendStreamInfAttr(lines[i], 'SUBTITLES', newResolutionInfo.Subtitles);
                                                        lines[i + 1] = newResolutionInfo.Url + ' '.repeat(i + 1);// 各 URL の行が一意でないとストリームが読み込まれない
                                                    }
                                                }
                                            }
                                        }
                                        if (decodableResolutionList.length > 0 || AlwaysReloadPlayerOnAd) {
                                            streamInfo.ModifiedM3U8 = lines.join('\n');
                                        }
                                    }
                                }
                                // 注意: ここで streamInfo.LastPlayerReload を設定してはならない。以前は新しいストリーム
                                // セッションの生成時に無条件で設定しており、そのせいで新しいチャンネルの最初の
                                // 広告終了時の再読み込みが必ずクールダウンでブロックされていた。実際には再読み込みが
                                // 行われていないのに、クールダウンの判定がセッション生成時のタイムスタンプを
                                // 直近の再読み込みとみなしてしまうためである。
                                resolve(new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime)));
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
    function hasAdTags(textStr) {
        return AdSignifiers.some((s) => s && textStr.includes(s));
    }
    // 広告完了のイベントを Twitch のバックエンドに偽装送信し、広告の状態を解除する
    function notifyAdComplete(textStr, streamInfo) {
        try {
            // 複数広告のポッドでは 1 回のポーリングにつき 1 本ずつ現れる。SpoofedAdIds がポーリングをまたいで重複を排除する。
            const matches = [...textStr.matchAll(/#EXT-X-DATERANGE:(ID="stitched-ad-[^\n]+)\n/g)];
            if (matches.length === 0) {
                if (!notifyAdComplete.loggedNoMatch) {
                    notifyAdComplete.loggedNoMatch = true;
                    const dateRangeLine = textStr.match(/#EXT-X-DATERANGE:[^\n]{0,200}/);
                    console.log('[AD DEBUG] notifyAdComplete: stitched-ad の DATERANGE に一致しませんでした。DATERANGE の例: ' + (dateRangeLine ? dateRangeLine[0] : '見つかりません'));
                }
                return;
            }
            const spoofedSet = (streamInfo && streamInfo.SpoofedAdIds) || null;
            const podLenMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
            const podLength = podLenMatch ? parseInt(podLenMatch[1], 10) : matches.length;
            // Twitch がポッドのサイズを宣言していたかどうか。宣言がない場合、podLength は今回のポーリングでの
            // 一致数にすぎないため、size>=podLength のチェックは最初の広告で打ち切られてしまい
            // （後続の広告のスプーフが不足する）、pod_complete も誤って送信されてしまう。size と podLength を
            // 比較するすべてのチェックはこのフラグで条件付ける（GosuDRM/TTV-AB v9.6.4 + v9.7.3 に準拠）。
            // ポッドの長さが不明なら、早期に打ち切らず、pod_complete も捏造しない。
            const hasExplicitPodLength = !!podLenMatch;
            // ホットパスの早期打ち切り: 重複排除の集合がポッド全体をカバーした後は、残りのポーリングは
            // すべて無駄なので、一致ごとのループの前に抜ける。
            if (hasExplicitPodLength && spoofedSet && spoofedSet.size >= podLength) {
                return;
            }
            let newSpoofed = 0;
            let firstRollType = '';
            let podCompleteSent = false;
            for (let i = 0; i < matches.length; i++) {
                // 宣言されたポッドの長さで打ち切る（TTV-AB v9.4.1 に準拠）: Twitch は 1 回のポーリングで
                // X-TV-TWITCH-AD-POD-LENGTH が示すよりも多くの一意な stitched-ad の DATERANGE を出すことがある。
                // ポッドを超えてスプーフすると、ポッドが主張する数より多くの広告のビーコンを送ることになり
                // （内部的に矛盾したパターンになる）、「5/2 pod」のようなあり得ない合計がログに残る。
                // ループ前の早期打ち切りはポーリングをまたぐ場合しか捕捉できず、1 回のポーリング内の
                // 一致リストには効かない。
                if (hasExplicitPodLength && spoofedSet && spoofedSet.size >= podLength) break;
                // 軽量な ID の事前抽出 — 完全な parseAttributes() の前に重複をチェックする。
                const idMatch = matches[i][1].match(/^ID="([^"]+)"/);
                const stitchedAdId = idMatch ? idMatch[1] : '';
                if (spoofedSet && stitchedAdId && spoofedSet.has(stitchedAdId)) {
                    continue;
                }
                const attr = parseAttributes(matches[i][1]);
                const radToken = attr['X-TV-TWITCH-AD-RADS-TOKEN'];
                if (!radToken) {
                    if (i === 0 && !notifyAdComplete.loggedNoToken) {
                        notifyAdComplete.loggedNoToken = true;
                        console.log('[AD DEBUG] notifyAdComplete: DATERANGE に一致しましたが RADS トークンがありません。属性: ' + Object.keys(attr).join(', '));
                    }
                    continue;
                }
                const rollType = (attr['X-TV-TWITCH-AD-ROLL-TYPE'] || '').toLowerCase();
                if (!firstRollType) firstRollType = rollType;
                const adPosition = parseInt(attr['X-TV-TWITCH-AD-POD-POSITION'] || String(i), 10);
                const adDuration = parseInt(attr['X-TV-TWITCH-AD-DURATION'] || '0', 10) || 0;
                const payload = {
                    stitched: true,
                    ad_id: stitchedAdId,
                    roll_type: rollType,
                    creative_id: attr['X-TV-TWITCH-AD-CREATIVE-ID'] || '',
                    order_id: attr['X-TV-TWITCH-AD-ORDER-ID'] || '',
                    line_item_id: attr['X-TV-TWITCH-AD-LINE-ITEM-ID'] || '',
                    player_mute: false,
                    player_volume: 1.0,
                    visible: true,
                    duration: adDuration,
                    ad_position: adPosition,
                    total_ads: podLength
                };
                // 6 つのイベントを 1 回の GQL POST にまとめる。Twitch は配列によるバッチ処理に対応している。
                const makePacket = (event, extra) => ({
                    operationName: 'ClientSideAdEventHandling_RecordAdEvent',
                    variables: { input: { eventName: event, eventPayload: JSON.stringify({ ...payload, ...extra }), radToken } },
                    extensions: { persistedQuery: { version: 1, sha256Hash: '7e6c69e6eb59f8ccb97ab73686f3d8b7d85a72a0298745ccd8bfc68e4054ca5b' } }
                });
                if (spoofedSet && stitchedAdId) spoofedSet.add(stitchedAdId);
                const batch = [
                    makePacket('video_ad_impression'),
                    makePacket('video_ad_quartile_complete', { quartile: 1 }),
                    makePacket('video_ad_quartile_complete', { quartile: 2 }),
                    makePacket('video_ad_quartile_complete', { quartile: 3 }),
                    makePacket('video_ad_quartile_complete', { quartile: 4 }),
                ];
                // pod_complete はポッドにつき 1 回送る（広告ごとではない）。防御的なフォールバックとして広告ごとにも対応する。
                // ポッドの長さが不明な場合は決して送らない（podLength は今回のポーリングでの数にすぎない）。TTV-AB v9.7.3 に準拠。
                if (!spoofedSet || (hasExplicitPodLength && spoofedSet.size === podLength)) {
                    batch.push(makePacket('video_ad_pod_complete'));
                    podCompleteSent = true;
                }
                // GQL のレスポンスステータスを監視する。200 以外は Twitch がスプーフを拒否したことを意味する。
                gqlRequest(batch).then(response => {
                    if (response && response.status !== 200 && !notifyAdComplete.loggedBadStatus) {
                        notifyAdComplete.loggedBadStatus = true;
                        console.log('[AD DEBUG] notifyAdComplete: GQL のレスポンスステータス ' + response.status + ' — スプーフが拒否またはレート制限された可能性があります');
                    }
                }).catch(() => {});
                newSpoofed++;
            }
            if (newSpoofed > 0) {
                const total = spoofedSet ? spoofedSet.size : newSpoofed;
                const src = (streamInfo && streamInfo.ActiveBackupPlayerType) || 'primary';
                notifyAdComplete.sessionAdsSpoofed = (notifyAdComplete.sessionAdsSpoofed || 0) + newSpoofed;
                console.log('[AD DEBUG] 広告完了をスプーフしました — 新規 ' + newSpoofed + ' 本（ポッド ' + total + '/' + podLength + '）、roll: ' + firstRollType + '、src: ' + src + '、pod-complete: ' + (podCompleteSent ? 'あり' : 'なし') + ' [セッション累計: ' + notifyAdComplete.sessionAdsSpoofed + ' 本]');
            }
        } catch (err) {
            console.log('[AD DEBUG] 広告完了のスプーフに失敗しました: ' + err.message);
        }
    }
    function getMatchedAdSignifiers(textStr) {
        return AdSignifiers.filter((s) => textStr.includes(s));
    }
    // m3u8 プレイリストから広告セグメントを除去し、置き換え用にその URL をキャッシュする
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
        // AdSignifiers に含まれていない広告マーカー候補をログに出力する（今後追加する候補）
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
            // 部分一致による判定（完全一致ではない）: いずれかの AdSignifier が含まれていれば、
            // その候補は「既知」とみなす。これにより 'twitch-stitched' のような接頭辞のシグニファイアが
            // 'EXT-X-DATERANGE:CLASS="twitch-stitched-ad"' などを網羅できる。
            const unknown = [...candidates].filter(c =>
                !AdSignifiers.some(s => s && c.includes(s)) &&
                !KnownNonAdSignifiers.some(s => s && c.includes(s))
            );
            if (unknown.length > 0) {
                streamInfo.HasLoggedUnknownSignifiers = true;
                console.log('[AD DEBUG] AdSignifiers にない広告マーカー候補を検出: ' + unknown.join(', ') + '（今後追加する候補）');
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
            lines[i] = line.replaceAll(TwitchAdUrlRewriteRegex, `$1${newAdUrl}$2`);
            const isLiveSegment = line.includes(',live');
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (!isLiveSegment || stripAllSegments || AllSegmentsAreAdSegments || inCueOut)) {
                const segmentUrl = lines[i + 1];
                if (!AdSegmentCache.has(segmentUrl)) {
                    streamInfo.NumStrippedAdSegments++;
                }
                AdSegmentCache.set(segmentUrl, Date.now());
                hasStrippedAdSegments = true;
            } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && AdSegmentURLPatterns.some((p) => lines[i + 1].includes(p))) {
                console.log('[AD DEBUG] URL パターンから広告セグメントを検出: ' + lines[i + 1]);
                AdSegmentCache.set(lines[i + 1], Date.now());
                hasStrippedAdSegments = true;
                streamInfo.NumStrippedAdSegments++;
            } else if (i < lines.length - 1 && line.startsWith('#EXTINF') && isLiveSegment) {
                liveSegments.push({ extinf: line, url: lines[i + 1] });
            } else if (line.startsWith('#EXT-X-PART:')) {
                // LL-HLS のパート: URI は属性としてインラインに書かれている。既知の広告 URL に一致する場合は除去する
                // （並行する EXTINF の除去によりすでにキャッシュにあるか、URL パターンに一致する場合）。
                // これがないと、プレイヤーが低遅延のパート経路から広告メディアを取得してしまう可能性がある。
                const partUriMatch = line.match(UriAttributeRegex);
                const partUri = partUriMatch ? partUriMatch[1] : '';
                if (partUri && (AdSegmentCache.has(partUri) || AdSegmentURLPatterns.some((p) => partUri.includes(p)))) {
                    AdSegmentCache.set(partUri, Date.now());
                    lines[i] = '';
                    hasStrippedAdSegments = true;
                }
            } else if (line.startsWith('#EXT-X-TWITCH-PREFETCH:') || line.startsWith('#EXT-X-PRELOAD-HINT:')) {
                // LL-HLS の prefetch / preload のヒントは、EXTINF の行や広告シグニファイアがプレイリストに
                // 現れる前に、これから来る広告セグメントを指していることがある。ここで検出することで、
                // 最初のポーリングで hasStrippedAdSegments が true になり、ループ後の無条件の prefetch 除去が
                // 発火する。TTV-AB 52b41b4 から移植。
                let hintUrl = '';
                if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    hintUrl = line.substring('#EXT-X-TWITCH-PREFETCH:'.length).trim();
                } else {
                    const hintMatch = line.match(UriAttributeRegex);
                    hintUrl = hintMatch ? hintMatch[1] : '';
                }
                if (hintUrl && (AdSegmentCache.has(hintUrl) || AdSegmentURLPatterns.some((p) => hintUrl.includes(p)))) {
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
            streamInfo.TotalAllStrippedPolls = (streamInfo.TotalAllStrippedPolls || 0) + 1;
            if (!streamInfo.FreezeStartedAt) streamInfo.FreezeStartedAt = Date.now();
            // メイン: 新しいプレイリスト全体のスナップショット（1.5 秒以内のもので、それ自体が広告マーカーを含まないこと）
            const snapshotAge = streamInfo.LastCleanNativePlaylistAt ? (Date.now() - streamInfo.LastCleanNativePlaylistAt) : Infinity;
            // 広告後の再突入ガード（TTV-AB v9.1.3 に準拠）: 広告後 8 秒の再読み込みウィンドウ内に
            // 次の広告が始まった場合、スナップショットが広告終了時の再読み込み境界をまたぎ、
            // 前のサイクルの古い内容を再生してしまうことがある。その場合はスナップショットを使わず、
            // 今回の広告のポーリングから作り直されるセグメント単位の復旧キャッシュにフォールバックする。
            const recentReloadReentry = streamInfo.LastPlayerReload && (Date.now() - streamInfo.LastPlayerReload) < 8000;
            if (streamInfo.LastCleanNativeM3U8 && snapshotAge <= 1500 && !recentReloadReentry && !hasAdTags(streamInfo.LastCleanNativeM3U8)) {
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
        } else if (liveSegments.length > 0) {
            // ライブセグメントが利用できるようになったらフリーズのカウンターをリセットする
            streamInfo.ConsecutiveAllStrippedPolls = 0;
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
            // FIFO による上限 — サイズが 1000 を超えたら古い方から 200 件を削除する。
            if (AdSegmentCache.size > 1000) {
                let evicted = 0;
                for (const url of AdSegmentCache.keys()) {
                    AdSegmentCache.delete(url);
                    if (++evicted >= 200) break;
                }
                if (!streamInfo.LoggedAdCacheSize1k) {
                    streamInfo.LoggedAdCacheSize1k = true;
                    console.log('[AD DEBUG] AdSegmentCache が 1000 件を超えました — 古い ' + evicted + ' 件を削除（現在 ' + AdSegmentCache.size + ' 件）');
                }
            }
        }
        return lines.join('\n');
    }
    // マスターの m3u8 から、指定された解像度に最も近いストリーム URL を探す
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
                            return matchedResolutionUrl;
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
        return closestResolutionUrl;
    }
    // 広告ブロックの中核ロジック: m3u8 内の広告を検出し、バックアップストリームを取得し、広告セグメントを除去する
    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }
        if (HasTriggeredPlayerReload) {
            HasTriggeredPlayerReload = false;
            streamInfo.LastPlayerReload = Date.now();
        }
        if (!streamInfo.LoggedOfflineTransition && textStr.includes('#EXT-X-ENDLIST') && !textStr.includes('#EXTINF:')) {
            streamInfo.LoggedOfflineTransition = true;
            console.log('[AD DEBUG] 配信終了 / オフラインの形を検出 — m3u8 に #EXT-X-ENDLIST があり、セグメントがありません。Twitch による検出への対応、配信者による配信終了、または通常の配信終了の可能性があります');
        }
        if (!streamInfo.HasCheckedUnknownTags) {
            streamInfo.HasCheckedUnknownTags = true;
            const unknownAdTags = textStr.match(/#EXT[^:\n]*(?:ad|cue|scte|sponsor)[^:\n]*/gi);
            if (unknownAdTags) {
                const unknown = unknownAdTags.filter(t => !AdSignifiers.some(s => s && t.includes(s)));
                if (unknown.length > 0) {
                    console.log('[AD DEBUG] 未知の広告関連タグを検出: ' + [...new Set(unknown)].join(', '));
                }
            }
        }
        const haveAdTags = hasAdTags(textStr) || SimulatedAdsDepth > 0;
        // 全セグメントが除去された場合の復旧フォールバック用に、クリーンなメインストリームの m3u8 をキャッシュする。
        // TTV-AB の LastCleanNativeM3U8 の仕組みに準拠。広告のないポーリング時にプレイリスト全体の
        // スナップショットを取得しておき、広告によってメインのプレイリストが完全に除去された場合に
        // stripAdSegments から再利用する。
        if (!haveAdTags && !streamInfo.IsShowingAd && textStr.indexOf('#EXTINF') !== -1) {
            streamInfo.LastCleanNativeM3U8 = textStr;
            streamInfo.LastCleanNativePlaylistAt = Date.now();
        }
        if (haveAdTags) {
            const adEndStalenessMs = 12000;
            if (streamInfo.PendingAdEndAt && (Date.now() - streamInfo.PendingAdEndAt) < adEndStalenessMs) {
                streamInfo.AdEndBounceCount = (streamInfo.AdEndBounceCount || 0) + 1;
            } else {
                streamInfo.PendingAdEndAt = 0;
                streamInfo.AdEndBounceCount = 0;
            }
            streamInfo.CleanPlaylistCount = 0;
            streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
            if (!streamInfo.IsShowingAd) {
                streamInfo.IsShowingAd = true;
                streamInfo.AdBreakStartedAt = Date.now();
                const podLengthMatch = textStr.match(/X-TV-TWITCH-AD-POD-LENGTH="(\d+)"/);
                const podLength = podLengthMatch ? parseInt(podLengthMatch[1], 10) : 1;
                // 新しい広告のために早期再読み込みの状態をリセットする。ポッド内の広告 1 本につき早期再読み込みを 1 回まで許可する
                streamInfo.PodLength = podLength;
                streamInfo.EarlyReloadTriggered = false;
                streamInfo.EarlyReloadCount = 0;
                streamInfo.EarlyReloadAtPoll = 0;
                streamInfo.SawCSAIFastPath = false;
                streamInfo.LastCommittedBackupPlayerType = null;
                streamInfo.FreezeStartedAt = 0;
                streamInfo.CycleRescuedThisBreak = false;
                console.log('[AD DEBUG] 広告を検出 — 種別: ' + (streamInfo.IsMidroll ? 'midroll' : 'preroll') + '、チャンネル: ' + streamInfo.ChannelName + '、ポッド: ' + podLength + ' 本（想定 約' + (podLength * 30) + '秒）、シグニファイア: ' + getMatchedAdSignifiers(textStr).join(', '));
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: false
                });
            }
            // 広告ありのポーリングのたびにスプーフする。複数広告のポッドは SpoofedAdIds が重複を排除する。
            if (!DisableAdSpoofing) {
                // プレイリストのクリティカルパスから外して遅延実行する。ここで同期的に matchAll + パース +
                // JSON.stringify を行うと、変更済み m3u8 のプレイヤーへの返却が遅れる（広告時のカクつき）。
                // 次のティックで十分であり、スプーフのビーコンは時間的にシビアではない。
                // （同じスプーフのコードについて GosuDRM TTV-AB v8.0.0 で実地確認された知見。）
                setTimeout(() => notifyAdComplete(textStr, streamInfo), 0);
            }
            if (!streamInfo.IsMidroll) {
                const lines = textStr.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                        if (!line.includes(',live') && !streamInfo.RequestedAds.has(lines[i + 1])) {
                            // .m3u8 のリクエスト 1 回につき .ts ファイルを 1 つだけ要求し、リクエストが多くなりすぎないようにする
                            streamInfo.RequestedAds.add(lines[i + 1]);
                            fetch(lines[i + 1]).then((response) => response.blob()).catch(() => {});
                            break;
                        }
                    }
                }
            }
            const currentResolution = streamInfo.Urls[url];
            if (!currentResolution) {
                console.log('解像度の情報が取得できないため広告が漏れます: ' + url);
                return stripAdSegments(textStr, false, streamInfo);
            }
            const isHevc = currentResolution.Codecs.startsWith('hev') || currentResolution.Codecs.startsWith('hvc');
            // 広告後の再読み込みループのガード: 直近 8 秒以内にプレイヤーの再読み込みが起きていればスキップする。
            const postAdReentryGuardMs = 8000;
            const recentlyReloaded = streamInfo.LastPlayerReload && (Date.now() - streamInfo.LastPlayerReload) < postAdReentryGuardMs;
            if (((isHevc && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8 && !recentlyReloaded) {
                streamInfo.IsUsingModifiedM3U8 = true;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            }
            // スティッキーな CSAI 高速経路: 今回の広告中の以前のポーリングで CSAI のみであることが確認済みなら、
            // Twitch が古いバッファ済みのセグメントを返し始めて hasNonLiveSegment が true になっても、
            // 高速経路にとどまる。これにより、2 回目以降のポーリングで遅いバックアップ探索が走り、
            // 広告終了から数十秒後に完了して、クリア済みの streamInfo の状態を古いバックアップのデータで
            // 上書きしてしまうのを防ぐ（release の PR #124）。
            // スティッキー CSAI の脱出処理（PreferLowQualityBackup）: 約 8 秒停止したらバックアップ探索に移行する。
            if (PreferLowQualityBackup && streamInfo.SawCSAIFastPath && (streamInfo.ConsecutiveAllStrippedPolls || 0) >= 4) {
                const stuckPolls = streamInfo.ConsecutiveAllStrippedPolls;
                const recoveryCacheSize = streamInfo.RecoverySegments?.length || 0;
                const earlyReloadInfo = (streamInfo.EarlyReloadCount || 0) + '/' + Math.max(1, streamInfo.PodLength || 1);
                console.log('[AD DEBUG] スティッキー CSAI の脱出処理 — ' + stuckPolls + ' 回のポーリング（約' + (stuckPolls * 2) + '秒）停止、EarlyReloadCount=' + earlyReloadInfo + '、復旧キャッシュ=' + recoveryCacheSize + ' セグメント。バックアップ探索に移行します');
                streamInfo.SawCSAIFastPath = false;
                streamInfo.EscapeHatchFired = true;
            }
            if (streamInfo.SawCSAIFastPath && !streamInfo.IsUsingModifiedM3U8) {
                // 広告の間はスティッキーな高速経路にとどまる。途中での解除は行わない。
                // 実際の EXTINF の広告セグメントはこれまでどおり stripAdSegments がセグメントキャッシュで処理するため
                // （キャッシュされた URL には fetch フックが BLANK_MP4 を返す）、バックアップに切り替えなくても
                // 広告はブロックされる。CSAI の広告全体でバックアップ探索を省略することで約 20 回の無駄な取得が
                // 減る。どのプレイヤータイプでも同じ CSAI 広告が入るため、どのみちバックアップは役に立たない。
                if (IsAdStrippingEnabled) {
                    textStr = stripAdSegments(textStr, false, streamInfo);
                }
                // 長時間フリーズした場合の早期再読み込み — 通常のバックアップ探索の経路にある判定と同じもので、
                // スティッキー経路から早期に return するとこれを完全に飛ばしてしまうため、ここにも置いている。
                // これがないと、CSAI と確認済みのストリームで SSAI の重い広告が来たとき、プレイヤーは広告の間ずっと
                // 薄い復旧キャッシュを再生し続けることになる。ポッド内の広告 1 本につき maxEarlyReloads までに制限する。
                if (streamInfo.EarlyReloadAwaitingResult) {
                    streamInfo.EarlyReloadAwaitingResult = false;
                    console.log('[AD DEBUG] 早期再読み込みの結果（スティッキー経路）: まだ広告あり — 復旧のループを継続します');
                    streamInfo.EarlyReloadTriggered = false;
                }
                const stickyRecoveryThin = (streamInfo.RecoverySegments?.length || 0) < 3;
                const stickyMaxEarlyReloads = stickyRecoveryThin ? Math.max(2, streamInfo.PodLength || 1) : Math.max(1, streamInfo.PodLength || 1);
                const stickyEffectiveThreshold = stickyRecoveryThin ? 1 : EarlyReloadPollThreshold;
                if (EarlyReloadPollThreshold > 0 && (streamInfo.ConsecutiveAllStrippedPolls || 0) >= stickyEffectiveThreshold && !streamInfo.EarlyReloadTriggered && (streamInfo.EarlyReloadCount || 0) < stickyMaxEarlyReloads) {
                    streamInfo.EarlyReloadTriggered = true;
                    streamInfo.EarlyReloadAwaitingResult = true;
                    streamInfo.EarlyReloadCount = (streamInfo.EarlyReloadCount || 0) + 1;
                    streamInfo.EarlyReloadAtPoll = streamInfo.TotalAllStrippedPolls || streamInfo.ConsecutiveAllStrippedPolls;
                    const stickyReason = stickyRecoveryThin ? ' (thin recovery cache: ' + (streamInfo.RecoverySegments?.length || 0) + ' segments)' : '';
                    console.log('[AD DEBUG] 早期再読み込みを発動（スティッキー経路）— 全セグメント除去のポーリングが ' + streamInfo.ConsecutiveAllStrippedPolls + ' 回連続' + stickyReason + ' [' + streamInfo.EarlyReloadCount + '/' + stickyMaxEarlyReloads + ']');
                    postMessage({ key: 'ReloadPlayer', kind: 'early' });
                }
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
                    numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
                    activeBackupPlayerType: null
                });
                return textStr;
            }
            // CSAI 高速経路: メインストリームのセグメントがすべてライブであれば、バックアップの探索を省略する。
            // CSAI の広告は m3u8 の外部で配信されるため、メインストリームのセグメントはクリーンである。
            // トラッキング URL だけを除去してメインストリームをそのまま返し、20〜40 秒の再バッファリングの
            // 空白を招くバックアップストリームへの切り替えを回避する。
            const mainStreamLines = textStr.split(/\r?\n/);
            let hasNonLiveSegment = false;
            for (let i = 0; i < mainStreamLines.length; i++) {
                if (mainStreamLines[i].startsWith('#EXTINF') && !mainStreamLines[i].includes(',live')) {
                    hasNonLiveSegment = true;
                    break;
                }
            }
            // BackupSwapFirst（オプトイン）: スティッキーな CSAI 経路を完全に省略し、広告を検出したら常に
            // バックアップの探索に進む。TTV-AB のバックアップ切り替え優先のフローを模したもので、
            // 除去処理による MediaSource の混在（BLANK_MP4 の注入や復旧セグメントの再生がない）を避けられ、
            // ローディング表示が減るという報告がある。代償として広告のたびに追加の取得が発生する
            // （試行するバックアップタイプごとのトークン要求）。
            if (!hasNonLiveSegment && !streamInfo.IsUsingModifiedM3U8 && !BackupSwapFirst) {
                streamInfo.SawCSAIFastPath = true;
                console.log('[AD DEBUG] CSAI 高速経路 — 全セグメントがライブのため、バックアップ探索を省略します');
                if (IsAdStrippingEnabled) {
                    textStr = stripAdSegments(textStr, false, streamInfo);
                }
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
                    numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
                    activeBackupPlayerType: null
                });
                return textStr;
            }
            const backupSearchStart = Date.now();
            let backupColdTokenFetches = 0;// 診断: 今回のバックアップ探索でのコールドキャッシュのトークン往復回数（0 = ウォーム。encodings のキャッシュにヒット）
            let backupPlayerType = null;
            let backupM3u8 = null;
            let fallbackM3u8 = null;
            let startIndex = 0;
            let isDoingMinimalRequests = false;
            if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
                // プレイヤーの再読み込み時は多数のリクエストが発生するため、バックアップストリームの読み込みが遅くなる。長い遅延を防ぐため、一時的に単一のバージョンを優先して使う
                startIndex = PlayerReloadMinimalRequestsPlayerIndex;
                isDoingMinimalRequests = true;
            }
            // 利用可能であれば、固定されたバックアップのプレイヤータイプを最初に試す
            const playerTypesToTry = PreferLowQualityBackup ? [...BackupPlayerTypes, 'autoplay'] : [...BackupPlayerTypes];
            if (streamInfo.PinnedBackupPlayerType) {
                const pinnedIndex = playerTypesToTry.indexOf(streamInfo.PinnedBackupPlayerType);
                if (pinnedIndex > 0) {
                    playerTypesToTry.splice(pinnedIndex, 1);
                    playerTypesToTry.unshift(streamInfo.PinnedBackupPlayerType);
                }
            }
            // FastAutoplayFirstTry: 前回の広告で Source 帯を使い切っていた場合は autoplay を先頭に置く。
            // 連続で採用された回数が N の倍数になるたびに再探索する（チャンネルの回復を確認するため）。
            if (FastAutoplayFirstTry && streamInfo.LastBreakUsedEscapeHatch && PreferLowQualityBackup) {
                const FastAutoplayReprobeInterval = 5;
                const consecutive = streamInfo.FastAutoplayConsecutive || 0;
                if (consecutive >= FastAutoplayReprobeInterval) {
                    streamInfo.FastAutoplayConsecutive = 0;
                    if (!streamInfo.LoggedFastAutoplayReprobeThisBreak) {
                        streamInfo.LoggedFastAutoplayReprobeThisBreak = true;
                        console.log('[AD DEBUG] 高速 autoplay の再探索 — 高速 autoplay が ' + consecutive + ' 回連続したため Source 帯をテストします（チャンネル回復の確認）');
                    }
                } else {
                    const autoplayIdx = playerTypesToTry.indexOf('autoplay');
                    if (autoplayIdx > 0) {
                        playerTypesToTry.splice(autoplayIdx, 1);
                        playerTypesToTry.unshift('autoplay');
                        if (!streamInfo.LoggedFastAutoplayThisBreak) {
                            streamInfo.LoggedFastAutoplayThisBreak = true;
                            console.log('[AD DEBUG] 高速 autoplay を最初に試行 — 前回の広告で Source 帯を使い切ったため、autoplay から探索します');
                        }
                    }
                }
            }
            // リアルタイムの汚染状況による並べ替え: 広告中の 2 回目以降のポーリングでは、同じ広告中に
            // すでに広告ありとログされたタイプを反復の末尾に回す。これにより、未試行またはクリーンなタイプ
            // （SSAI が多いチャンネルでは通常 autoplay）を先に試せるようになり、汚染済みと分かっている
            // タイプを再確認せずに済む。LoggedBackupAdsByType は下の「also has ads」のログ地点で
            // 記録され、広告終了時にクリアされるため、この調整は広告ごとに適応的に働く。
            if (streamInfo.LoggedBackupAdsByType && streamInfo.LoggedBackupAdsByType.size > 0) {
                const clean = [];
                const contam = [];
                for (const t of playerTypesToTry) {
                    if (streamInfo.LoggedBackupAdsByType.has(t)) contam.push(t);
                    else clean.push(t);
                }
                if (contam.length > 0 && clean.length > 0) {
                    playerTypesToTry.length = 0;
                    playerTypesToTry.push(...clean, ...contam);
                    if (!streamInfo.LoggedContamReorderThisBreak) {
                        streamInfo.LoggedContamReorderThisBreak = true;
                        console.log('[AD DEBUG] 汚染状況に応じた並べ替え — 汚染済みの [' + contam.join(', ') + '] より先に [' + clean.join(', ') + '] を試します');
                    }
                }
            }
            for (let playerTypeIndex = startIndex; !backupM3u8 && playerTypeIndex < playerTypesToTry.length; playerTypeIndex++) {
                const playerType = playerTypesToTry[playerTypeIndex];
                const realPlayerType = playerType.replace('-CACHED', '');
                const failedAt = streamInfo.FailedBackupPlayerTypes.get(realPlayerType);
                // 5 秒（以前は 15 秒）: CSAI が切り替わる現在の状況では、汚染されたバックアップタイプが
                // 数秒で回復することがある。15 秒のロックアウトでは、すでにクリーンになったタイプを
                // 長く避けすぎていた（TTV-AB/GosuDRM v8.0.0 の「広告による停止の低減」）。代償として
                // 再試行の取得が約 3 倍になる。コールド / ウォームのトークン取得ログで監視している（#228）。
                if (failedAt && (Date.now() - failedAt) < 5000) {
                    continue;
                }
                const isFullyCachedPlayerType = playerType != realPlayerType;
                for (let i = 0; i < 2; i++) {
                    // 広告が含まれていない場合に m3u8 をキャッシュする。すでにあるキャッシュに広告が含まれている場合は新しいバージョンを取得する（2 番目のループ）
                    let isFreshM3u8 = false;
                    let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
                    if (!encodingsM3u8) {
                        isFreshM3u8 = true;
                        backupColdTokenFetches++;
                        try {
                            const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, realPlayerType);
                            if (accessTokenResponse.status === 200) {
                                const accessToken = await accessTokenResponse.json();
                                // Twitch が返す streamPlaybackAccessToken には次の 2 つの形状が観測されている:
                                //   { data: { streamPlaybackAccessToken: {...} } }（ほとんどのプレイヤータイプ）
                                //   { streamPlaybackAccessToken: {...} }（よりフラットな形。'embed' で観測）
                                // どちらも受け入れる。そうしないと embed のバックアップが黙って捨てられることが実地で確認されている。
                                const spat = accessToken?.data?.streamPlaybackAccessToken || accessToken?.streamPlaybackAccessToken;
                                if (!spat) {
                                    const errInfo = accessToken?.errors ? ' errors: ' + JSON.stringify(accessToken.errors).substring(0, 300) : '';
                                    console.log('[AD DEBUG] GQL のレスポンスに streamPlaybackAccessToken がありません（' + realPlayerType + '）。レスポンスのキー: ' + JSON.stringify(Object.keys(accessToken || {})) + errInfo);
                                    streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
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
                                if (encodingsM3u8Response.status === 200) {
                                    encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                                    streamInfo.ConsecutiveTokenFetchFailures = 0;
                                    streamInfo.LoggedTokenFailureStreak = false;
                                } else {
                                    console.log('[AD DEBUG] Usher の HTTP ' + encodingsM3u8Response.status + '（' + realPlayerType + '）');
                                }
                            } else {
                                let errorBody = '';
                                try { errorBody = ' — ' + (await accessTokenResponse.text()).substring(0, 200); } catch {}
                                console.log('[AD DEBUG] アクセストークンの HTTP ' + accessTokenResponse.status + '（' + realPlayerType + '）' + (accessTokenResponse.status === 403 ? '（integrity: ' + (ClientIntegrityHeader ? 'あり' : 'なし') + '）' : '') + errorBody);
                                streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                                streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                                if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                                    streamInfo.LoggedTokenFailureStreak = true;
                                    console.log('[AD DEBUG] トークン取得に失敗 — プレイヤータイプをまたいで ' + streamInfo.ConsecutiveTokenFetchFailures + ' 回連続。Twitch による検出 / integrity のローテーション / レート制限の可能性');
                                }
                            }
                        } catch (err) {
                            console.log('[AD DEBUG] アクセストークンの取得に失敗（' + realPlayerType + '）: ' + err.message);
                            streamInfo.FailedBackupPlayerTypes.set(realPlayerType, Date.now());
                            streamInfo.ConsecutiveTokenFetchFailures = (streamInfo.ConsecutiveTokenFetchFailures || 0) + 1;
                            if (streamInfo.ConsecutiveTokenFetchFailures >= 3 && !streamInfo.LoggedTokenFailureStreak) {
                                streamInfo.LoggedTokenFailureStreak = true;
                                console.log('[AD DEBUG] トークン取得に失敗 — プレイヤータイプをまたいで ' + streamInfo.ConsecutiveTokenFetchFailures + ' 回連続。Twitch による検出 / integrity のローテーション / レート制限の可能性');
                            }
                        }
                    }
                    if (encodingsM3u8) {
                        try {
                            const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);
                            const streamM3u8Response = await realFetch(streamM3u8Url);
                            if (streamM3u8Response.status == 200) {
                                const m3u8Text = await streamM3u8Response.text();
                                if (m3u8Text) {
                                    if (playerType == FallbackPlayerType) {
                                        fallbackM3u8 = m3u8Text;
                                    }
                                    if ((!hasAdTags(m3u8Text) && (SimulatedAdsDepth == 0 || playerTypeIndex >= SimulatedAdsDepth - 1)) || (!fallbackM3u8 && playerTypeIndex >= playerTypesToTry.length - 1)) {
                                        if ((streamInfo.ConsecutiveAllStrippedPolls || 0) >= 2 && !hasAdTags(m3u8Text)) {
                                            const prevType = streamInfo.LastCommittedBackupPlayerType;
                                            if (prevType && prevType !== playerType) {
                                                console.log('[AD DEBUG] 巡回により別のクリーンなタイプに切り替えました（' + playerType + '、以前は ' + prevType + '）— フリーズ中に再読み込みなしで回復しました');
                                                // 実際にプレイヤータイプを切り替えた場合のみ cycle-rescued として記録する。
                                                // 自然に回復した場合（同じタイプがクリーンになった場合）は、プレイヤーのバッファを
                                                // 更新するために広告終了時の再読み込みが依然として必要である。これを省略すると、
                                                // バッファが少ないままプレイヤーが固まり、バッファ監視でも回復できなくなる。
                                                streamInfo.CycleRescuedThisBreak = true;
                                            } else {
                                                console.log('[AD DEBUG] 同じバックアップタイプ（' + playerType + '）がフリーズ中にクリーンになりました — 自然に回復しました');
                                            }
                                        }
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                    if (hasAdTags(m3u8Text)) {
                                        if (!streamInfo.LoggedBackupAdsByType) streamInfo.LoggedBackupAdsByType = new Set();
                                        if (!streamInfo.LoggedBackupAdsByType.has(playerType)) {
                                            streamInfo.LoggedBackupAdsByType.add(playerType);
                                            console.log('[AD DEBUG] バックアップストリーム（' + playerType + '）にも広告があります');
                                        }
                                    }
                                    if (isFullyCachedPlayerType) {
                                        break;
                                    }
                                    // クリーンなものがあるかもしれないので、他のプレイヤータイプも引き続き試す。
                                    // 広告入りのバックアップを最終手段として採用するのは次の場合: リクエストを抑える期間中、
                                    // 除去 0 件の広告が 3 回以上続いた場合（誤検出）、または最後のタイプまで試した場合。
                                    if (isDoingMinimalRequests || streamInfo.ConsecutiveZeroStripBreaks >= 3 || playerTypeIndex >= playerTypesToTry.length - 1) {
                                        if (playerTypeIndex >= playerTypesToTry.length - 1 && !isDoingMinimalRequests && streamInfo.ConsecutiveZeroStripBreaks < 3) {
                                            console.log('[AD DEBUG] すべてのバックアップのプレイヤータイプが広告入り — 最終手段として ' + playerType + ' を採用します（除去 + 復旧の経路に入ります）');
                                        }
                                        backupPlayerType = playerType;
                                        backupM3u8 = m3u8Text;
                                        break;
                                    }
                                }
                            } else {
                                console.log('[AD DEBUG] バックアップストリームの取得に失敗（' + playerType + '、ステータス ' + streamM3u8Response.status + '）');
                            }
                        } catch (err) {
                            console.log('[AD DEBUG] バックアップストリームのエラー（' + playerType + '）: ' + err.message);
                        }
                    }
                    streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
                    if (isFreshM3u8) {
                        break;
                    }
                }
            }
            if (!backupM3u8 && fallbackM3u8) {
                // 今回の広告中にすでに汚染とマークしたタイプにはフォールバックしない。
                // このガードがないと、広告の途中ですべての Source タイプが広告ありになった場合、反復が
                // クリーンな確定のないまま終わり、なおかつ fallbackM3u8 が FallbackPlayerType の広告入り m3u8 を
                // 指したままになる。その結果、ポーリングのたびに同じ汚染されたサイトを黙って再採用してしまい
                // （ActiveBackupPlayerType が変わらないため「Blocking ads」のログも出ない）、ユーザーには失敗の
                // 手がかりもなく広告ポッド全体が表示される。それよりは backupM3u8 を null のままにして
                // 「No ad-free backup stream found」のログを出し、状況が見えるようにする方がよい。
                if (streamInfo.LoggedBackupAdsByType && streamInfo.LoggedBackupAdsByType.has(FallbackPlayerType)) {
                    console.log('[AD DEBUG] ' + FallbackPlayerType + ' へのフォールバックをスキップします — 今回の広告で汚染とマーク済み（' + [...streamInfo.LoggedBackupAdsByType].join(', ') + ' がすべて広告入り）');
                } else {
                    backupPlayerType = FallbackPlayerType;
                    backupM3u8 = fallbackM3u8;
                }
            }
            // 古い結果の採用を防ぐガード: 同じ streamInfo に対して複数の processM3U8 呼び出しが同時に
            // 実行されていることがある。このバックアップ探索が広告中に始まり、その後のポーリングが
            // 広告終了時のリセットを済ませた後で完了した場合、ここでバックアップを採用すると
            // クリア済みの状態を上書きし、古いプレイリストのデータをプレイヤーに渡してしまう
            // （release の PR #124）。IsShowingAd を確認して古い結果を破棄する。
            if (backupM3u8 && streamInfo.IsShowingAd) {
                textStr = backupM3u8;
                streamInfo.LastCommittedBackupPlayerType = backupPlayerType;
                if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
                    streamInfo.ActiveBackupPlayerType = backupPlayerType;
                    // ソース画質のバックアップタイプ（embed、site、popout）を自動的に固定し、次の広告で失敗したタイプを飛ばす。
                    // 画質のロックを避けるため、低画質のタイプ（autoplay、mobile_web）は決して自動固定しない。
                    // 具体的には、'autoplay' を固定すると playerTypesToTry の末尾から先頭に移動してしまい、
                    // 反復の最後のフォールバックが autoplay の 360p のバックアップではなく、別の広告入りの Source タイプを
                    // 採用してしまう。
                    const sourceQualityTypes = ['embed', 'site', 'popout'];
                    if ((PinBackupPlayerType && backupPlayerType !== 'autoplay') || sourceQualityTypes.includes(backupPlayerType)) {
                        streamInfo.PinnedBackupPlayerType = backupPlayerType;
                    }
                    console.log(`[AD DEBUG] ${(streamInfo.IsMidroll ? 'ミッドロール' : 'プリロール')}広告をブロック中（${backupPlayerType}）— バックアップを ${Date.now() - backupSearchStart}ms で取得${backupColdTokenFetches > 0 ? `（コールドキャッシュ: トークン取得 ${backupColdTokenFetches} 回）` : '（ウォームキャッシュ）'}`);
                    if (streamInfo.EscapeHatchFired) {
                        const qualityTier = backupPlayerType === 'autoplay' ? '360p' : 'Source';
                        console.log('[AD DEBUG] 脱出後のバックアップ: ' + backupPlayerType + '（' + qualityTier + '）— スティッキー経路のフリーズから回復しました');
                    } else if (backupPlayerType === 'autoplay' && PreferLowQualityBackup) {
                        const sourceTried = streamInfo.LoggedBackupAdsByType?.size || 0;
                        if (sourceTried === 0) {
                            console.log('[AD DEBUG] autoplay のバックアップを採用 — 前回の広告から固定された 360p（PreferLowQualityBackup）');
                            streamInfo.FastAutoplayConsecutive = (streamInfo.FastAutoplayConsecutive || 0) + 1;
                        } else {
                            console.log('[AD DEBUG] autoplay のバックアップを採用 — Source タイプ ' + sourceTried + ' 個が広告入りだったため 360p にフォールバック（PreferLowQualityBackup）');
                        }
                        if (FastAutoplayFirstTry && sourceTried >= 4) {
                            streamInfo.LastBreakUsedEscapeHatch = true;
                            streamInfo.FastAutoplayConsecutive = 0;
                        }
                    } else if (FastAutoplayFirstTry && backupPlayerType !== 'autoplay') {
                        streamInfo.LastBreakUsedEscapeHatch = false;
                        streamInfo.FastAutoplayConsecutive = 0;
                    }
                    streamInfo.LastBackupSwitch = Date.now();
                }
            } else if (backupM3u8 && !streamInfo.IsShowingAd) {
                console.log('[AD DEBUG] 古いバックアップの採用を破棄しました（' + backupPlayerType + '、' + (Date.now() - backupSearchStart) + 'ms）— 探索中に広告が終了しました');
            } else {
                console.log('[AD DEBUG] 広告のないバックアップストリームが見つかりません — 広告が漏れる可能性があります。試行: ' + playerTypesToTry.slice(startIndex).join(', '));
            }
            // TODO: HEVC の除去を改善する。コーデックの不一致がある場合は常に（双方向で）除去すべきである
            const stripHevc = isHevc && streamInfo.ModifiedM3U8;
            if (IsAdStrippingEnabled || stripHevc) {
                textStr = stripAdSegments(textStr, stripHevc, streamInfo);
            } else if (!backupM3u8) {
                console.log('[AD DEBUG] 広告の除去が無効でバックアップもありません — 広告が表示されます');
            }
            // 早期再読み込みが発動した次のポーリングで、再読み込みの結果をログに出す
            if (streamInfo.EarlyReloadAwaitingResult) {
                streamInfo.EarlyReloadAwaitingResult = false;
                if (textStr.includes(',live') && streamInfo.IsStrippingAdSegments) {
                    console.log('[AD DEBUG] 早期再読み込みの結果: 部分的 — 一部のライブセグメントが返りました');
                } else if (!streamInfo.IsStrippingAdSegments) {
                    console.log('[AD DEBUG] 早期再読み込みの結果: クリーン — フリーズが解消しました');
                    // 同じポッド内で再びフリーズしたときに再発動できるよう、発動フラグをリセットする（EarlyReloadCount / PodLength で上限が決まる）
                    streamInfo.EarlyReloadTriggered = false;
                } else {
                    console.log('[AD DEBUG] 早期再読み込みの結果: まだ広告あり — 復旧のループを継続します');
                    streamInfo.EarlyReloadTriggered = false;
                }
            }
            // 長時間フリーズした場合の早期再読み込み: 復旧セグメントを N 回以上のポーリングにわたって
            // ループしている場合は、新しい内容を得るために再読み込みを発動する。ポッド内の広告 1 本につき
            // 1 回までに制限する（広告 2 本のポッドなら最大 2 回の早期再読み込み）。
            const recoveryThin = (streamInfo.RecoverySegments?.length || 0) < 3;
            const maxEarlyReloads = recoveryThin ? Math.max(2, streamInfo.PodLength || 1) : Math.max(1, streamInfo.PodLength || 1);
            // 復旧キャッシュが薄い場合の高速経路: フォールバック用にキャッシュされたライブセグメントが
            // 3 個未満の場合、プレイヤーは数秒で使い切ってしまう。通常のしきい値を待たず、最初に
            // 全セグメントが除去されたポーリングの時点で早期再読み込みを発動する。1〜2 秒の再読み込みによる
            // 中断は、そうしなければ発生する除去 + バッファ再構築の停止（約 10〜15 秒）よりはるかに短い。
            const effectiveThreshold = recoveryThin ? 1 : EarlyReloadPollThreshold;
            if (EarlyReloadPollThreshold > 0 && (streamInfo.ConsecutiveAllStrippedPolls || 0) >= effectiveThreshold && !streamInfo.EarlyReloadTriggered && (streamInfo.EarlyReloadCount || 0) < maxEarlyReloads) {
                streamInfo.EarlyReloadTriggered = true;
                streamInfo.EarlyReloadAwaitingResult = true;
                streamInfo.EarlyReloadCount = (streamInfo.EarlyReloadCount || 0) + 1;
                streamInfo.EarlyReloadAtPoll = streamInfo.TotalAllStrippedPolls || streamInfo.ConsecutiveAllStrippedPolls;
                const reason = recoveryThin ? ' (thin recovery cache: ' + (streamInfo.RecoverySegments?.length || 0) + ' segments)' : '';
                console.log('[AD DEBUG] 早期再読み込みを発動 — 全セグメント除去のポーリングが ' + streamInfo.ConsecutiveAllStrippedPolls + ' 回連続' + reason + ' [' + streamInfo.EarlyReloadCount + '/' + maxEarlyReloads + ']');
                postMessage({ key: 'ReloadPlayer', kind: 'early' });
            }
        } else if (streamInfo.IsShowingAd) {
            if (!streamInfo.PendingAdEndAt) {
                streamInfo.PendingAdEndAt = Date.now();
            }
            streamInfo.CleanPlaylistCount++;
            // 現在のプレイリストにライブセグメントがあるか確認する。なければバックアップストリームは停止している
            const hasLiveSegments = textStr.includes(',live');
            const adEndMaxWaitMs = 12000;
            const elapsedSinceCandidate = Date.now() - streamInfo.PendingAdEndAt;
            const slowPathReady = streamInfo.PendingAdEndAt > 0 && elapsedSinceCandidate >= adEndMaxWaitMs;
            if (streamInfo.CleanPlaylistCount >= 3 || !hasLiveSegments || slowPathReady) {
                if (slowPathReady && streamInfo.CleanPlaylistCount < 3) {
                    console.log('[AD DEBUG] 低速経路による広告終了の判定 — マーカーの揺れ ' + (streamInfo.AdEndBounceCount || 0) + ' 回、最初のクリーンなポーリングから ' + (elapsedSinceCandidate / 1000).toFixed(1) + ' 秒');
                }
                if (!hasLiveSegments) {
                    console.log('[AD DEBUG] バックアップストリームにライブセグメントがありません — 即時に再読み込みします');
                }
                const adBreakDurationSec = streamInfo.AdBreakStartedAt ? ((Date.now() - streamInfo.AdBreakStartedAt) / 1000).toFixed(1) : '?';
                console.log('[AD DEBUG] 広告のブロックが完了 — 広告セグメントを ' + streamInfo.NumStrippedAdSegments + ' 個除去、所要時間: ' + adBreakDurationSec + ' 秒（IsUsingModifiedM3U8: ' + streamInfo.IsUsingModifiedM3U8 + '）');
                if (streamInfo.TotalAllStrippedPolls > 0) {
                    const reloadInfo = streamInfo.EarlyReloadAtPoll ? ', early reload at poll ' + streamInfo.EarlyReloadAtPoll : '';
                    const wallClockFreeze = streamInfo.FreezeStartedAt ? ((Date.now() - streamInfo.FreezeStartedAt) / 1000).toFixed(1) + 's wall-clock' : 'unknown';
                    console.log('[AD DEBUG] 広告の統計: 全セグメント除去のポーリング ' + streamInfo.TotalAllStrippedPolls + ' 回、フリーズ時間: ' + wallClockFreeze + reloadInfo);
                }
                const hadStrippedSegments = streamInfo.NumStrippedAdSegments > 0;
                // 誤検出のガードに数えるのは、CSAI のみの広告でも、バックアップ切り替え優先の広告でもない場合に限る。
                // CSAI の広告は m3u8 の外部で配信される本物の広告であり、除去セグメントが 0 になるのは当然である。
                // BackupSwapFirst は広告を検出するたびにバックアップへ切り替えるため、除去 0 は仕様どおりである
                // （ネイティブの除去は行わず、バックアップを提供するだけである）。
                if (!hadStrippedSegments && !streamInfo.SawCSAIFastPath && !BackupSwapFirst) {
                    if (!streamInfo.ConsecutiveZeroStripBreaks) streamInfo.ConsecutiveZeroStripBreaks = 0;
                    streamInfo.ConsecutiveZeroStripBreaks++;
                    if (streamInfo.ConsecutiveZeroStripBreaks >= 3) {
                        console.log('[AD DEBUG] 警告: 除去 0 件の非 CSAI の広告が ' + streamInfo.ConsecutiveZeroStripBreaks + ' 回連続しています — 広告シグニファイアによる誤検出の可能性があります');
                    }
                } else if (hadStrippedSegments || streamInfo.SawCSAIFastPath || BackupSwapFirst) {
                    // リセットは上のインクリメントのガードと対称になっている。「広告をきれいに処理できた」という
                    // 肯定的なシグナルがあれば、誤検出の履歴をリセットする。これにより、古い疑わしい履歴が
                    // 正常に処理された広告に持ち越されるのを防ぐ。
                    streamInfo.ConsecutiveZeroStripBreaks = 0;
                }
                streamInfo.IsShowingAd = false;
                streamInfo.IsStrippingAdSegments = false;
                streamInfo.NumStrippedAdSegments = 0;
                streamInfo.ActiveBackupPlayerType = null;
                streamInfo.RequestedAds?.clear?.();
                streamInfo.SpoofedAdIds?.clear?.();// 新しい広告 = 広告スプーフの重複排除の集合を作り直す
                streamInfo.FailedBackupPlayerTypes?.clear?.();
                // 固定していたタイプが今回の広告中に汚染された場合は固定を解除する。次の広告で最初の取得を
                // 無駄にしないためである。pge4 で実地確認済み: PinBackupPlayerType=true により
                // PinnedBackupPlayerType には最後に採用したタイプが設定されるが、そのタイプが広告の途中で
                // 汚染された場合でも、次の広告で最初にそれを試してしまっていた。
                if (streamInfo.PinnedBackupPlayerType && streamInfo.LoggedBackupAdsByType && streamInfo.LoggedBackupAdsByType.has(streamInfo.PinnedBackupPlayerType)) {
                    console.log('[AD DEBUG] 固定していたバックアップタイプ ' + streamInfo.PinnedBackupPlayerType + ' の固定を解除します — 今回の広告で汚染されたため、次の広告で最初の試行を無駄にしてしまいます');
                    streamInfo.PinnedBackupPlayerType = null;
                }
                if (streamInfo.LoggedBackupAdsByType) streamInfo.LoggedBackupAdsByType.clear();
                streamInfo.LoggedContamReorderThisBreak = false;
                streamInfo.CleanPlaylistCount = 0;
                streamInfo.PendingAdEndAt = 0;
                streamInfo.AdEndBounceCount = 0;
                streamInfo.ConsecutiveAllStrippedPolls = 0;
                streamInfo.EarlyReloadTriggered = false;
                streamInfo.EarlyReloadAwaitingResult = false;
                streamInfo.EarlyReloadAtPoll = 0;
                streamInfo.TotalAllStrippedPolls = 0;
                streamInfo.HasLoggedAdAttributes = false;
                streamInfo.HasLoggedUnknownSignifiers = false;
                streamInfo.LoggedFastAutoplayThisBreak = false;
                streamInfo.LoggedFastAutoplayReprobeThisBreak = false;
                streamInfo.SawCSAIFastPath = false;// 次の広告のためにスティッキー CSAI のフラグをクリアする
                streamInfo.EscapeHatchFired = false;
                // クールダウンの自動延長: 直近 2 分間に 3 回以上の再読み込みがあれば、クールダウンを 3 倍にして連鎖の圧力を下げる
                if (!streamInfo.ReloadTimestamps) streamInfo.ReloadTimestamps = [];
                streamInfo.ReloadTimestamps = streamInfo.ReloadTimestamps.filter(t => Date.now() - t < 300000);
                const recentReloads = streamInfo.ReloadTimestamps.filter(t => Date.now() - t < 300000).length;
                const effectiveCooldown = recentReloads >= 3 ? ReloadCooldownSeconds * 3 : ReloadCooldownSeconds;
                const tooSoonSinceLastReload = streamInfo.LastPlayerReload && (Date.now() - streamInfo.LastPlayerReload) < (effectiveCooldown * 1000);
                // CSAI のみの広告: バックアップは使われたが、除去されたセグメントはなかった。
                // 再読み込みを完全に省略する。広告の多いチャンネルでの CSAI 連鎖を避けるためである。
                // フラグをクリアすることで、次の m3u8 のポーリングからメインストリームをそのまま提供できる。
                if (!hadStrippedSegments) {
                    console.log('[AD DEBUG] CSAI のみの広告（除去 0 件）— プレイヤーを操作せずバックアップを解除します');
                    streamInfo.IsUsingModifiedM3U8 = false;
                    // 例外: 今回の広告中にバックアップが 1 度でも採用された場合（脱出処理、または
                    // cycleRescuedCleanly の条件を満たさなかった巡回による復旧）、MediaSource のバッファには
                    // 異なるソースのセグメントが混在している（別のプレイヤータイプのアクセストークンで取得した
                    // バックアップと、ネイティブに取得したもの）。混在すると音声と映像のトラックのタイムスタンプが
                    // ずれることがあり、再読み込みしないとそのずれが以降の脱出処理のたびに累積する。
                    // ハード再読み込みを強制して MediaSource のバッファを流し、アクセストークンを更新する。
                    // 特に autoplay（360p）の場合、再読み込みによって Source 画質も復元される
                    // （autoplay スコープのトークンは 360p のバリアントしか提供しない）。
                    if (streamInfo.LastCommittedBackupPlayerType) {
                        const isAutoplay = streamInfo.LastCommittedBackupPlayerType === 'autoplay';
                        const reason = isAutoplay ? 'autoplay (360p) — restoring Source quality' : streamInfo.LastCommittedBackupPlayerType + ' — flushing MediaSource to prevent A/V desync accumulation';
                        console.log('[AD DEBUG] 広告終了時の再読み込み: ' + reason);
                        streamInfo.LastPlayerReload = Date.now();
                        if (!streamInfo.ReloadTimestamps) streamInfo.ReloadTimestamps = [];
                        streamInfo.ReloadTimestamps.push(Date.now());
                        postMessage({ key: 'ReloadPlayer', kind: 'early' });
                    }
                } else {
                // 巡回による復旧で広告をきれいに処理できた場合は、広告終了時の再読み込みを省略する:
                // 2 ポーリング以下（約 4 秒）のフリーズがクリーンなバックアップへの切り替えで解消され、
                // 早期再読み込みも不要だった場合である。プレイヤーは正常なバックアップストリームで動いており、
                // 本来のプレイヤータイプに戻すためだけに再読み込みすると、不要な 1〜2 秒のローディング表示が
                // 発生してしまう。
                const cycleRescuedCleanly = streamInfo.CycleRescuedThisBreak &&
                    (streamInfo.TotalAllStrippedPolls || 0) <= 2 &&
                    (streamInfo.EarlyReloadCount || 0) === 0;
                if (cycleRescuedCleanly) {
                    console.log('[AD DEBUG] 巡回による復旧で広告をきれいに処理できました — 広告終了時の再読み込みを省略します');
                }
                // バックアップが使われ、かつセグメントが除去された場合は再読み込みする（クリーンな状態にする必要があるため）。
                // 広告後の再読み込みはクールダウンを迂回する。これは広告の自然な終了に伴うバッファのフラッシュであり、
                // 連鎖のリスクがある再試行ではない。広告のサイクル自体がこの経路を制限している（広告 1 回につき 1 度）。
                const shouldReload = streamInfo.IsUsingModifiedM3U8 || (ReloadPlayerAfterAd && hadStrippedSegments && !cycleRescuedCleanly);
                // issue #129 のモード D: 今回の広告では除去処理がなかった → MediaSource には何も注入されていないため、
                // ハード再読み込みによるフラッシュは不要である。ソフト再読み込み（'post-ad'）はメディア要素を再利用し、
                // デスクトップでの黒画面 + 再生アイコンを伴う破棄を回避する。除去のあった広告は BLANK_MP4 / 復旧による
                // 音ズレを解消するためハード（'early'）のままにする。広告途中の脱出には影響しない（それらは独自に 'early' を送る）。
                const reloadKind = (SoftReloadNoStrip && !hadStrippedSegments) ? 'post-ad' : 'early';
                console.log('[AD DEBUG] 再読み込みの判断: shouldReload=' + shouldReload + ' kind=' + reloadKind + ' IsUsingModifiedM3U8=' + streamInfo.IsUsingModifiedM3U8 + ' hadStripped=' + hadStrippedSegments + ' tooSoon=' + tooSoonSinceLastReload + ' cooldown=' + effectiveCooldown + '秒' + (tooSoonSinceLastReload && shouldReload ? '（広告後のためクールダウンを迂回）' : ''));
                if (shouldReload) {
                    streamInfo.ReloadTimestamps.push(Date.now());// 実際に行った再読み込みだけを記録し、スキップしたものは記録しない
                    streamInfo.IsUsingModifiedM3U8 = false;
                    streamInfo.LastPlayerReload = Date.now();
                    postMessage({
                        key: 'ReloadPlayer',
                        kind: reloadKind
                    });
                } else {
                    if (tooSoonSinceLastReload) {
                        console.log('[AD DEBUG] 再読み込みをスキップします — 直近の再読み込みは ' + ((Date.now() - streamInfo.LastPlayerReload) / 1000).toFixed(0) + ' 秒前（クールダウン: ' + effectiveCooldown + ' 秒' + (recentReloads >= 3 ? '、5 分間に ' + recentReloads + ' 回の再読み込みにより自動延長' : '') + '）');
                    }
                    postMessage({
                        key: 'PauseResumePlayer'
                    });
                }
                }// else の終わり（CSAI 以外の経路）
            }
        }
        postMessage({
            key: 'UpdateAdBlockBanner',
            isMidroll: streamInfo.IsMidroll,
            hasAds: streamInfo.IsShowingAd,
            isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
            numStrippedAdSegments: streamInfo.NumStrippedAdSegments,
            activeBackupPlayerType: streamInfo.ActiveBackupPlayerType
        });
        return textStr;
    }
    function parseAttributes(str) {
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
            .filter(Boolean)
            .map(x => {
                const idx = x.indexOf('=');
                const key = x.substring(0, idx);
                const value = x.substring(idx + 1);
                const num = Number(value);
                return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
            }));
    }
    // 指定されたプレイヤータイプで Twitch の GQL に再生用アクセストークンを要求する
    function getAccessToken(channelName, playerType) {
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: "",
                playerType: playerType,
                platform: playerType == 'autoplay' ? 'android' : 'web'
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
    // メインスレッド経由で Twitch に GQL リクエストを送る（ワーカーは認証情報付きのリクエストを送れない）
    function gqlRequest(body) {
        if (!GQLDeviceID) {
            GQLDeviceID = '';
            const dcharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';
            const dcharactersLength = dcharacters.length;
            for (let i = 0; i < 32; i++) {
                GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharactersLength));
            }
        }
        let headers = {
            'Client-ID': ClientID,
            'X-Device-Id': GQLDeviceID,
            'Authorization': AuthorizationHeader,
            ...(ClientIntegrityHeader && {'Client-Integrity': ClientIntegrityHeader}),
            ...(ClientVersion && {'Client-Version': ClientVersion}),
            ...(ClientSession && {'Client-Session-Id': ClientSession})
        };
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
            pendingFetchRequests.set(requestId, {
                resolve,
                reject
            });
            postMessage({
                key: 'FetchRequest',
                value: fetchRequest
            });
        });
    }
    let playerForMonitoringBuffering = null;
    let driftCatchUpInterval = null;
    let driftCatchUpTimeout = null;
    function startDriftCorrection(videoElement) {
        if (DriftCorrectionRate <= 1) return;
        if (driftCatchUpInterval) { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
        if (driftCatchUpTimeout) { clearTimeout(driftCatchUpTimeout); driftCatchUpTimeout = null; }
        videoElement.playbackRate = DriftCorrectionRate;
        console.log('[AD DEBUG] ドリフト補正: ' + DriftCorrectionRate + ' 倍速で追いつきます');
        driftCatchUpInterval = setInterval(() => {
            try {
                const vid = document.querySelector('video');
                if (vid && vid.buffered.length > 0) {
                    if (vid.buffered.end(vid.buffered.length - 1) - vid.currentTime <= 1) {
                        vid.playbackRate = 1.0;
                        console.log('[AD DEBUG] ドリフト補正が完了 — 通常の再生速度に戻しました');
                        clearInterval(driftCatchUpInterval); driftCatchUpInterval = null;
                        if (driftCatchUpTimeout) { clearTimeout(driftCatchUpTimeout); driftCatchUpTimeout = null; }
                    }
                }
            } catch { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
        }, 500);
        driftCatchUpTimeout = setTimeout(() => {
            try { videoElement.playbackRate = 1.0; } catch {}
            if (driftCatchUpInterval) { clearInterval(driftCatchUpInterval); driftCatchUpInterval = null; }
            driftCatchUpTimeout = null;
        }, 30000);
    }
    const playerBufferState = {
        channelName: null,
        hasStreamStarted: false,
        position: 0,
        bufferedPosition: 0,
        bufferDuration: 0,
        numSame: 0,
        fixAttempts: 0,
        lastFixTime: 0,
        isLive: true
    };
    // プレイヤーの状態をポーリングし、広告のストリーム切り替えによるバッファリングを検出して修正する
    function monitorPlayerBuffering() {
        // 本体が例外を投げても、次のティックは必ず再スケジュールする。そうしないと、想定外の例外が
        // 1 度起きただけで（Twitch 側のプレイヤーの形状変更などで）、以降そのセッションの間ずっと
        // 停止 / 再生位置フリーズ / ミュートの復旧がすべて黙って動かなくなってしまう。
        // GosuDRM/TTV-AB v9.8.4 に準拠。
        let rescheduleDelay = PlayerBufferingDelay;
        try {
        // 毎ティックでプレイヤーを取得し直す（Twitch 側がプレイヤーを再生成した際に古い参照を使わないようにする）
        playerForMonitoringBuffering = null;
        {
            const playerAndState = getPlayerAndState();
            if (playerAndState && playerAndState.player && playerAndState.state) {
                playerForMonitoringBuffering = {
                    player: playerAndState.player,
                    state: playerAndState.state
                };
                // video 要素に対するユーザーの一時停止意図を追跡する（要素ごとに 1 回）
                const video = playerAndState.player.getHTMLVideoElement?.();
                if (video && !video.__tasIntentHooked) {
                    video.__tasIntentHooked = true;
                    video.addEventListener('pause', () => {
                        if (!playerBufferState.weJustPaused || (Date.now() - playerBufferState.weJustPaused) > 2000) {
                            playerBufferState.userPauseIntent = true;
                        }
                    });
                    video.addEventListener('play', () => {
                        playerBufferState.userPauseIntent = false;
                        playerBufferState.loggedPauseIntent = false;
                    });
                }
            }
        }
        if (playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const state = playerForMonitoringBuffering.state;
                if (!player.core) {
                    playerForMonitoringBuffering = null;
                } else if (state.props?.content?.type === 'live' && !player.isPaused() && !player.getHTMLVideoElement()?.ended && (player.getHTMLVideoElement()?.readyState ?? 0) >= 1 && playerBufferState.lastFixTime <= Date.now() - PlayerBufferingMinRepeatDelay && !isActivelyStrippingAds && !playerBufferState.inAdBreak && (!playerBufferState.lastReloadAt || Date.now() - playerBufferState.lastReloadAt >= 15000) && (!playerBufferState.lastBackupSwitchAt || Date.now() - playerBufferState.lastBackupSwitchAt >= 10000)) {
                    const m3u8Url = player.core?.state?.path;
                    if (m3u8Url) {
                      const lastSlash = m3u8Url.lastIndexOf('/');
                      const queryStart = m3u8Url.indexOf('?', lastSlash);
                      const fileName = m3u8Url.substring(lastSlash + 1, queryStart !== -1 ? queryStart : undefined);
                      if (fileName?.endsWith('.m3u8')) {
                          const channelName = fileName.slice(0, -5);
                          if (playerBufferState.channelName != channelName) {
                              playerBufferState.channelName = channelName;
                              playerBufferState.hasStreamStarted = false;
                              playerBufferState.numSame = 0;
                              playerBufferState.fixAttempts = 0;
                              playerBufferState.recoveryReloadUsed = false;
                              playerBufferState.userPauseIntent = false;
                        playerBufferState.loggedPauseIntent = false;
                          }
                      }
                    }
                    if (player.getState() === 'Playing') {
                        playerBufferState.hasStreamStarted = true;
                    }
                    const position = player.core?.state?.position;
                    const bufferedPosition = player.core?.state?.bufferedPosition;
                    const bufferDuration = player.getBufferDuration();
                    // 実際の再生の進行については video.currentTime を正とする。state.position は currentTime が
                    // なめらかに進んでいる間も約 12 秒フリーズして見えることがある（PR #194 / issue #193）。
                    const videoEl = player.getHTMLVideoElement?.();
                    const videoCurrentTime = videoEl?.currentTime;
                    if (position !== undefined && bufferedPosition !== undefined) {
                        // 注意: ここは改善の余地がある。現状ではプレイヤーがバッファを完全に使い切ってから一時停止 / 再生を発動している
                        // <video> が実際に再生していないとき（readyState < 2 または一時停止中）はスキップする。
                        const playerNotActivelyPlaying = videoEl && (videoEl.readyState < 2 || videoEl.paused);
                        // FFZ の音声コンプレッサーは player.load() のたびに <video> 要素を作り直す。
                        // 要素の同一性が変わったら新たな再読み込みとみなし、カウンターをクリアして、
                        // 再生成後の立ち上がりを停止として数えないようにする。
                        if (videoEl && playerBufferState.videoElement && playerBufferState.videoElement !== videoEl) {
                            playerBufferState.numSame = 0;
                            playerBufferState.fixAttempts = 0;
                            playerBufferState.recoveryReloadUsed = false;
                        }
                        playerBufferState.videoElement = videoEl;
                        const positionFrozen = (playerBufferState.position == position) &&
                            (playerBufferState.videoCurrentTime === undefined || playerBufferState.videoCurrentTime === videoCurrentTime);
                        if (playerNotActivelyPlaying) {
                            // カウンターを保持する — 増やしもリセットもしない。
                        } else if (playerBufferState.hasStreamStarted &&
                            (!PlayerBufferingPrerollCheckEnabled || position > PlayerBufferingPrerollCheckOffset) &&
                            // AND に厳しくする: 本当の停止とは、再生位置のフリーズとバッファの減少が同時に起きている状態である。
                            // Firefox でライブ端にいるときの報告では、OR の形だと通常の細いバッファでの息継ぎ
                            // （バッファ 1〜2 秒、セグメント取得待ちで currentTime が一瞬止まる）でも発動していた。
                            // その場合の一時停止 / 再生がプレイヤーを readyState=1、currentTime=0 に戻してしまい、
                            // 自己増幅的な再読み込みの連鎖に発展していた。
                            (positionFrozen && bufferDuration < PlayerBufferingDangerZone)  &&
                            playerBufferState.bufferedPosition == bufferedPosition &&
                            playerBufferState.bufferDuration >= bufferDuration &&
                            (position != 0 || bufferedPosition != 0 || bufferDuration != 0)
                        ) {
                            playerBufferState.numSame++;
                            if (playerBufferState.numSame == PlayerBufferingSameStateCount) {
                                playerBufferState.fixAttempts++;
                                // 上限: 1 回の復旧ウィンドウにつき再読み込みは最大 1 回。1 度再読み込みしたら、
                                // 再生が回復するまでは一時停止 / 再生で対応する。再読み込みの連鎖を防ぐ。
                                const wouldEscalate = playerBufferState.fixAttempts >= 3;
                                const escalateToReload = wouldEscalate && (DisableReloadCap || !playerBufferState.recoveryReloadUsed);
                                const reloadCapNote = wouldEscalate && !escalateToReload ? ' (reload cap reached, pause/play only — set twitchAdSolutions_disableReloadCap=true to bypass)' : (escalateToReload ? ' (escalating to reload)' : '');
                                console.log('バッファリングの修正を試みます position:' + playerBufferState.position + ' bufferedPosition:' + playerBufferState.bufferedPosition + ' bufferDuration:' + playerBufferState.bufferDuration + reloadCapNote);
                                // 停止したままにせず、バッファの空白を越えてシークする
                                const video = player.getHTMLVideoElement?.();
                                if (video && video.buffered.length > 1) {
                                    for (let bi = 0; bi < video.buffered.length; bi++) {
                                        if (video.buffered.start(bi) > video.currentTime + 0.5) {
                                            console.log('[AD DEBUG] ' + (video.buffered.start(bi) - video.currentTime).toFixed(1) + ' 秒のバッファの空白を越えてシークします');
                                            video.currentTime = video.buffered.start(bi);
                                            startDriftCorrection(video);
                                            break;
                                        }
                                    }
                                }
                                if (video) {
                                    console.log('[AD DEBUG] 動画の状態: readyState=' + video.readyState + ' networkState=' + video.networkState + ' buffered=' + (video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1).toFixed(1) : 0) + ' currentTime=' + video.currentTime.toFixed(1) + ' paused=' + video.paused);
                                }
                                const isPausePlay = escalateToReload ? false : !PlayerBufferingDoPlayerReload;
                                const isReload = escalateToReload ? true : PlayerBufferingDoPlayerReload;
                                doTwitchPlayerTask(isPausePlay, isReload);
                                playerBufferState.lastFixTime = Date.now();
                                playerBufferState.numSame = 0;
                                if (escalateToReload) {
                                    playerBufferState.fixAttempts = 0;
                                    playerBufferState.recoveryReloadUsed = true;
                                }
                            }
                        } else {
                            playerBufferState.numSame = 0;
                            playerBufferState.fixAttempts = 0;
                            playerBufferState.recoveryReloadUsed = false;
                        }
                        // 位置飛び（ネイティブの空白復旧）を検出してドリフト補正で追いつく。
                        // 広告中とその後 10 秒間はスキップする: バックアップストリームの切り替えでバッファに空白が生じ、誤検出の原因になるため。
                        // 30 秒に 1 回に制限する: 再読み込みの多いチャンネルでは、Twitch の player.core.state.position が
                        // 約 12 秒ごとに約 60 秒飛ぶことが実地で確認されている（おそらく m3u8 マニフェストの更新や
                        // program-date-time の同期点によるまとめて更新であり、実際のずれではない）。こちらの 1.1 倍速の
                        // videoElement.playbackRate は state.position には影響しないため、12 秒ごとに再発火しても
                        // 無意味なログの氾濫にしかならない。追いつき処理はすでにライブ端にある currentTime に対して働く。
                        // レート制限により 30 秒あたり 1 回のドリフト試行にまとめられる。実際のずれを扱う経路
                        // （バッファ空白のシーク、再読み込み後）は startDriftCorrection() を直接呼び、この検出器を
                        // 通らないため影響を受けない。
                        if (playerBufferState.position > 0 && position - playerBufferState.position > 5 && !playerBufferState.inAdBreak && (!playerBufferState.lastBackupSwitchAt || Date.now() - playerBufferState.lastBackupSwitchAt >= 10000) && (!playerBufferState.lastDriftStartedAt || Date.now() - playerBufferState.lastDriftStartedAt >= 30000)) {
                            console.log('[AD DEBUG] 再生位置が ' + (position - playerBufferState.position).toFixed(1) + ' 秒飛びました — ドリフト補正を開始します');
                            startDriftCorrection(player.getHTMLVideoElement?.());
                            playerBufferState.lastDriftStartedAt = Date.now();
                        }
                        playerBufferState.position = position;
                        playerBufferState.videoCurrentTime = videoCurrentTime;
                        playerBufferState.bufferedPosition = bufferedPosition;
                        playerBufferState.bufferDuration = bufferDuration;
                    } else {
                        playerBufferState.numSame = 0;
                    }
                }
            } catch (err) {
                console.error('プレイヤーのバッファリング監視でエラーが発生しました: ' + err);
                playerForMonitoringBuffering = null;
            }
        }
        // 広告中の、空白でフリーズした場合のシーク（GosuDRM/TTV-AB の _trySeekPastFrozenBufferGap、#33 / v9.7.5 に準拠）:
        // メインのバッファ停止の復旧は !inAdBreak を条件としており、除去時の復旧は除去中しか発動しないため、
        // CSAI の広告では空白でフリーズした autoplay のバックアップに復旧手段がない（ローディング表示のまま）。
        // 再生位置が本当にフリーズしていること（監視 3 ティックの間まったく進まず、かつ readyState < 3 で
        // データ不足であること）を確認したうえで、バッファの空白を越えてシークする。ライブ限定かつフリーズ確認済みなので、
        // VOD の内容を飛ばしたり、プレイヤーがまだ進んでいるのに発動したりすることはない。
        if (playerBufferState.inAdBreak && !isActivelyStrippingAds && !DisableInAdGapSeek && playerForMonitoringBuffering
            && playerForMonitoringBuffering.state?.props?.content?.type === 'live') {
            try {
                const v = playerForMonitoringBuffering.player?.getHTMLVideoElement?.();
                const ct = v ? v.currentTime : 0;
                const last = playerBufferState.gapJumpLastPosition;
                if (!v || last === undefined || last < 0 || ct > last + 0.2 || ct < last) {
                    playerBufferState.gapJumpStuckTicks = 0;
                } else {
                    playerBufferState.gapJumpStuckTicks = (playerBufferState.gapJumpStuckTicks || 0) + 1;
                }
                playerBufferState.gapJumpLastPosition = ct;
                if (v && !v.paused && !v.ended && (playerBufferState.gapJumpStuckTicks || 0) >= 3 && (v.readyState ?? 4) < 3 && v.buffered && v.buffered.length > 1) {
                    for (let i = 0; i < v.buffered.length; i++) {
                        const gapStart = v.buffered.start(i);
                        if (gapStart > ct + 0.25) {
                            console.log('[AD DEBUG] 広告中のバッファの空白のシーク — 再生位置 ' + ct.toFixed(1) + ' 秒で ' + playerBufferState.gapJumpStuckTicks + ' ティックの間フリーズ（readyState ' + v.readyState + '）。空白を越えて ' + (gapStart - ct).toFixed(1) + ' 秒先の ' + gapStart.toFixed(1) + ' 秒へシークします（TTV-AB #33 に準拠）');
                            v.currentTime = gapStart + 0.05;
                            playerBufferState.gapJumpStuckTicks = 0;
                            playerBufferState.gapJumpLastPosition = -1;
                            break;
                        }
                    }
                }
            } catch {}
        }
        // 広告中の再生位置フリーズに対する再読み込みへの段階的移行（readyState に依存しない最終防衛線）。
        // 上のシークは readyState < 3 かつ映像バッファに空白がある場合しか発動せず、下のローディング表示による
        // 再読み込みは isActivelyStrippingAds を条件とする（CSAI の広告では false になる）。音声だけのバッファの空白では
        // （映像は先までバッファされているので readyState は高いまま）、固定された autoplay のバックアップが
        // 広告終了時の再読み込みまで復旧手段なくフリーズする。約 60 秒の CSAI 停止が観測されている。
        // ここでは「再生中なのに currentTime が進まない」ことだけで再生位置のフリーズを検出し（readyState や
        // バッファの形状は問わない）、シークやブラウザ側の処理に約 10 秒の猶予を与えたうえで、ハード再読み込みを行う
        // （MediaSource を再構築する）。連発しないようクールダウンで保護している。無効にするには
        // twitchAdSolutions_disableInAdFreezeReload=true を設定する。
        if (playerBufferState.inAdBreak && !DisableInAdFreezeReload && !playerBufferState.userPauseIntent && playerForMonitoringBuffering
            && playerForMonitoringBuffering.state?.props?.content?.type === 'live') {
            try {
                const fv = playerForMonitoringBuffering.player?.getHTMLVideoElement?.();
                const fct = fv ? fv.currentTime : 0;
                const flast = playerBufferState.adFreezeLastPosition;
                const frozen = fv && !fv.paused && !fv.ended && fct > 0
                    && flast !== undefined && flast >= 0 && Math.abs(fct - flast) < 0.2;
                playerBufferState.adFreezeLastPosition = fct;
                const fnow = Date.now();
                if (!frozen) {
                    if (playerBufferState.adFreezeStartAt && (fnow - playerBufferState.adFreezeStartAt) > 3000) {
                        console.log('[AD DEBUG] 広告中の再生位置のフリーズが段階的移行の前に解消しました — ' + ((fnow - playerBufferState.adFreezeStartAt) / 1000).toFixed(1) + ' 秒フリーズしていましたが、現在は進行しています（シークまたはブラウザ側の処理により回復）');
                    }
                    playerBufferState.adFreezeStartAt = 0;
                    playerBufferState.adFreezeSuppressLogged = false;
                    playerBufferState.adFreezeDetectedLogged = false;
                } else if (!playerBufferState.adFreezeStartAt) {
                    // フリーズを検出した最初のティックでは、何も出さずにタイマーだけ開始する。ここでログを出さないこと:
                    // カクついた / 遅い再生ではティックごとにフリーズと進行が交互に現れ、そのたびに再設定と
                    // 「検出」のログが繰り返されてしまう（実際にログの氾濫が観測されている）。フリーズが継続した
                    // 場合にのみ通知する（3 秒超、下を参照）。
                    playerBufferState.adFreezeStartAt = fnow;
                    playerBufferState.adFreezeSuppressLogged = false;
                    playerBufferState.adFreezeDetectedLogged = false;
                } else {
                    const frozenMs = fnow - playerBufferState.adFreezeStartAt;
                    if (frozenMs > 3000 && !playerBufferState.adFreezeDetectedLogged) {
                        playerBufferState.adFreezeDetectedLogged = true;
                        console.log('[AD DEBUG] 広告中の再生位置のフリーズが ' + (frozenMs / 1000).toFixed(1) + ' 秒継続、位置 ' + fct.toFixed(1) + ' 秒（readyState ' + (fv.readyState ?? '?') + '、バッファ範囲 ' + (fv.buffered ? fv.buffered.length : '?') + '）— 10 秒を超えてもフリーズしていればハード再読み込みします');
                    }
                    const freezeReloadCooldown = 15000;
                    const cooldownOk = !playerBufferState.lastAdFreezeReloadAt || (fnow - playerBufferState.lastAdFreezeReloadAt) > freezeReloadCooldown;
                    const recentReload = playerBufferState.lastReloadAt && (fnow - playerBufferState.lastReloadAt) < freezeReloadCooldown;
                    if (frozenMs > 10000) {
                        if (cooldownOk && !recentReload) {
                            console.log('[AD DEBUG] 広告中の再生位置フリーズの段階的移行 — 広告中に再生位置 ' + fct.toFixed(1) + ' 秒で ' + (frozenMs / 1000).toFixed(1) + ' 秒フリーズ（readyState ' + (fv.readyState ?? '?') + '、バッファ範囲 ' + (fv.buffered ? fv.buffered.length : '?') + '［1 なら映像は連続しており、シークでは検出できません］、シークでは回復しませんでした）— ハード再読み込みします');
                            playerBufferState.lastAdFreezeReloadAt = fnow;
                            playerBufferState.adFreezeStartAt = 0;
                            playerBufferState.adFreezeLastPosition = -1;
                            doTwitchPlayerTask(false, true, 'early');
                        } else if (!playerBufferState.adFreezeSuppressLogged) {
                            playerBufferState.adFreezeSuppressLogged = true;
                            console.log('[AD DEBUG] 広告中の再生位置が ' + (frozenMs / 1000).toFixed(1) + ' 秒フリーズしていますが、再読み込みを抑制しました（15 秒以内に再読み込みが発生: cooldownBlocked=' + (!cooldownOk) + '、recentReload=' + (!!recentReload) + '）— 広告終了時の再読み込みに任せます');
                        }
                    }
                }
            } catch {}
        } else if (playerBufferState.adFreezeStartAt) {
            // 広告中の再生位置フリーズを監視していない状態（広告が終了した / 一時停止中 / ライブではない）。
            // 古い adFreezeStartAt が広告と広告の間に漏れないよう、フリーズのタイマーをクリアする:
            // 広告が終わるのとちょうど同時に再生位置がフリーズすると、!frozen によるリセットに達する前に
            // このブロックの実行が止まり（inAdBreak が条件のため）、古いタイムスタンプが残ってしまう。
            // それを次の広告が読むと、数分に及ぶ偽のフリーズとして扱われ（981 秒の「回復」が観測されている）、
            // 広告開始時の最初のティックが古い位置と比べてフリーズと判定された場合に誤って段階的移行を
            // 起こす可能性もある。
            playerBufferState.adFreezeStartAt = 0;
            playerBufferState.adFreezeLastPosition = -1;
            playerBufferState.adFreezeDetectedLogged = false;
            playerBufferState.adFreezeSuppressLogged = false;
        }
        // 広告終了後の映像の詰まりからの復旧（GosuDRM/TTV-AB の _checkPostBreakWedge、v12.0.0 に準拠）:
        // 「広告の後、音声は流れているのに映像がフリーズする」ケース（タブを切り替えて戻ったときによく起きる）である。
        // 再生位置は進み続けるが（音声のクロックは生きている）、デコーダーがフレームを出さなくなる。
        // そのため、上の currentTime を基準にしたフリーズ判定（adFreezeStartAt やシーク）は構造的にこれを検出できない。
        // デコード済みフレーム数で直接検出する: 広告→広告なしの変化点で監視を開始し、currentTime は進んだのに
        // getVideoPlaybackQuality().totalVideoFrames が増えなかったティックを記録する。一時停止 / 再生、
        // 続いてハード再読み込みへと段階的に移行する。無効にするには
        // twitchAdSolutions_disablePostBreakWedge=true を設定する。
        {
            const wedgeInAd = !!playerBufferState.inAdBreak;
            // 広告終了の変化点（広告中だったが今は違う）で作動させ、約 40 ティックの監視ウィンドウを開始する。
            if (playerBufferState.wedgePrevInAdBreak && !wedgeInAd) {
                playerBufferState.wedgeEvalsRemaining = 40;
                playerBufferState.wedgeLastTime = -1;
                playerBufferState.wedgeLastFrames = -1;
                playerBufferState.wedgeEvidence = 0;
                playerBufferState.wedgeHealthy = 0;
                playerBufferState.wedgeActions = 0;
            }
            playerBufferState.wedgePrevInAdBreak = wedgeInAd;
            if (!DisablePostBreakWedge && !wedgeInAd && (playerBufferState.wedgeEvalsRemaining || 0) > 0
                && !playerBufferState.userPauseIntent && playerForMonitoringBuffering
                && playerForMonitoringBuffering.state?.props?.content?.type === 'live') {
                try {
                    const wv = playerForMonitoringBuffering.player?.getHTMLVideoElement?.();
                    // 要素が実際に再生中のときのみ評価できる: 再生中で、映像トラックがあり、
                    // メタデータがデコード済みで、再生品質の API が利用できること。それ以外は待機する（予算を消費しない）。
                    if (wv && !wv.ended && !wv.paused && wv.videoWidth > 0 && (wv.readyState ?? 0) >= 2
                        && typeof wv.getVideoPlaybackQuality === 'function') {
                        let totalFrames = -1;
                        try { totalFrames = Number(wv.getVideoPlaybackQuality()?.totalVideoFrames); } catch {}
                        if (Number.isFinite(totalFrames) && totalFrames >= 0) {
                            const t = wv.currentTime || 0;
                            const prevT = playerBufferState.wedgeLastTime;
                            const prevF = playerBufferState.wedgeLastFrames;
                            playerBufferState.wedgeLastTime = t;
                            playerBufferState.wedgeLastFrames = totalFrames;
                            // 基準値と、実際に再生位置が進んでいることの両方が必要である（再生位置のフリーズは別のブロックの
                            // 担当であり、ここでは「時間は進むのにフレームが増えない」状態だけを対象とする）。
                            if (prevT >= 0 && prevF >= 0 && t > prevT + 0.3) {
                                playerBufferState.wedgeEvalsRemaining--;
                                const framesDelta = totalFrames - prevF;
                                if (framesDelta < 0) {
                                    // フレームのカウンターが逆行した → メディア要素が再生成された（再読み込み）。
                                    // 上で基準を取り直しているため、この境界は証拠として数えない。
                                    playerBufferState.wedgeEvidence = 0;
                                    playerBufferState.wedgeHealthy = 0;
                                } else if (framesDelta >= 5) {
                                    // デコーダーは正常でフレームを生成している。正常なティックが数回続いたら監視を解除する。
                                    playerBufferState.wedgeEvidence = 0;
                                    playerBufferState.wedgeHealthy = (playerBufferState.wedgeHealthy || 0) + 1;
                                    if (playerBufferState.wedgeHealthy >= 3) playerBufferState.wedgeEvalsRemaining = 0;
                                } else if (framesDelta <= 1) {
                                    // 詰まりの証拠 — 再生位置は進んでいるのに新しいフレームがほぼ生成されていない。
                                    playerBufferState.wedgeHealthy = 0;
                                    playerBufferState.wedgeEvidence = (playerBufferState.wedgeEvidence || 0) + 1;
                                    if (playerBufferState.wedgeEvidence >= 6) {
                                        playerBufferState.wedgeEvidence = 0;
                                        playerBufferState.wedgeActions = (playerBufferState.wedgeActions || 0) + 1;
                                        const wedgeReload = playerBufferState.wedgeActions >= 2;// まず軽く promote し、再発したら再読み込みする
                                        const recentReload = playerBufferState.lastReloadAt && (Date.now() - playerBufferState.lastReloadAt) < 15000;
                                        console.log('[AD DEBUG] 広告終了後の映像の詰まり — 再生位置は ' + t.toFixed(1) + ' 秒まで進んでいるのに、' + (t - prevT).toFixed(1) + ' 秒間でデコードされたフレームは ' + Math.max(0, framesDelta) + ' 個だけです（広告後に音声のみ動作し映像がフリーズ）— ' + (wedgeReload ? 'ハード再読み込み' : '一時停止 / 再生で促します') + '（TTV-AB v12.0.0 に準拠）');
                                        if (wedgeReload) {
                                            playerBufferState.wedgeEvalsRemaining = 0;
                                            if (!recentReload) {
                                                doTwitchPlayerTask(false, true, 'early');
                                            } else {
                                                console.log('[AD DEBUG] 広告終了後の詰まりに対する再読み込みを抑制しました — 15 秒以内に再読み込みが発生しているため、そちらに任せます');
                                            }
                                        } else {
                                            doTwitchPlayerTask(true, false);
                                        }
                                        playerBufferState.lastFixTime = Date.now();
                                    }
                                } else {
                                    // 判断がつかない場合（2〜4 フレーム）: 正常とも詰まりとも言えないため、
                                    // 正常が続いた回数はリセットしつつ、蓄積した証拠は保持する（TTV-AB に準拠）。
                                    playerBufferState.wedgeHealthy = 0;
                                }
                            }
                        }
                    }
                } catch {}
            }
        }
        // ローディング表示のヘルスチェック: 広告の除去 + 復旧のループ中は通常のバッファ監視が
        // 無効化されている（isActivelyStrippingAds）ため、そのままでは目に見えて停止したプレイヤーが
        // ワーカーのポーリングによる早期再読み込み（約 10 秒）を待つことになる。ここでは停止の
        // 約 3 秒後にそれを検出して直接再読み込みを行い、ローディング表示の時間をほぼなくす。
        if (isActivelyStrippingAds && playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const video = player?.getHTMLVideoElement?.();
                if (video && !video.ended && !playerBufferState.userPauseIntent) {
                    // プレイヤーが一度でもデータを持ったことがあるかを追跡する。これにより本当の停止
                    // （データがあったのに失った）と、プレイヤーの初期化中（まだ一度もデータがない）を区別できる。
                    // これがないと、ページを読み込んだ直後のプリロール広告で PR #96 が何度も誤発動する。
                    // 初期化中は readyState=0 が正常な状態だからである。
                    if (video.readyState >= 3) {
                        playerBufferState.hasHadData = true;
                    }
                    const isStalled = video.readyState < 3 && (video.paused || video.networkState === 2);
                    const stallReloadCooldown = 15000;
                    const cooldownExpired = !playerBufferState.lastAdStallReloadAt || (Date.now() - playerBufferState.lastAdStallReloadAt) > stallReloadCooldown;
                    // 直近に何らかの再読み込みが起きている場合はローディング表示による再読み込みを発動しない。
                    // readyState=0 は再読み込み時の MediaSource 破棄中に想定される一時的な状態である。
                    // これがないと、実行中の早期再読み込みが余分なローディング表示由来の再読み込みを誘発しうる。
                    const recentReload = playerBufferState.lastReloadAt && (Date.now() - playerBufferState.lastReloadAt) < stallReloadCooldown;
                    if (isStalled && cooldownExpired && !recentReload && playerBufferState.hasHadData) {
                        if (!playerBufferState.adStallStartAt) {
                            playerBufferState.adStallStartAt = Date.now();
                        } else if ((Date.now() - playerBufferState.adStallStartAt) > 3000) {
                            console.log('[AD DEBUG] 広告中にローディング表示を検出（' + ((Date.now() - playerBufferState.adStallStartAt) / 1000).toFixed(1) + ' 秒の停止、readyState=' + video.readyState + '）— 早期再読み込みを行います');
                            playerBufferState.lastAdStallReloadAt = Date.now();
                            playerBufferState.adStallStartAt = 0;
                            // ハード再読み込み: 固まったメディアプレイヤーには m3u8 の再取得だけでなく MediaSource の再構築が必要である。
                            doTwitchPlayerTask(false, true, 'early');
                        }
                    } else if (!isStalled) {
                        playerBufferState.adStallStartAt = 0;
                    }
                }
            } catch {}
        } else if (!isActivelyStrippingAds && playerBufferState.adStallStartAt) {
            playerBufferState.adStallStartAt = 0;
        }
        const isLive = playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
        if (playerBufferState.isLive && !isLive) {
            updateAdblockBanner({
                hasAds: false
            });
        }
        playerBufferState.isLive = isLive;
        // タブが表示状態になったら即座にティックを実行し、復帰時に停止を素早く検出する
        if (typeof document !== 'undefined' && !monitorPlayerBuffering.visibilityHooked) {
            monitorPlayerBuffering.visibilityHooked = true;
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && !monitorPlayerBuffering.pendingTick) {
                    monitorPlayerBuffering.pendingTick = true;
                    setTimeout(() => { monitorPlayerBuffering.pendingTick = false; monitorPlayerBuffering(); }, 100);
                }
            });
        }
        // hasAds が false に変わった後も残り続ける広告のオーバーレイ（「広告を再生しています / そのままお待ちください」など）を捕捉する。
        // updateAdblockBanner が hideTwitchAdOverlays を呼ぶのは広告中だけだが、
        // 一部のオーバーレイは独自のライフサイクルを持ち、その後も表示され続ける。
        // 監視の毎ティック（1〜3 秒間隔）でここを実行すれば、専用のインターバルを設けずに非表示を維持できる。
        try { hideTwitchAdOverlays(); } catch {}
        // 可視状態に応じたバックオフ: タブが非表示のときはポーリングを 3 分の 1 の頻度にする（ただし PiP 中は除く。ユーザーは視聴中のため）。
        // 例外: 広告中はバックオフしない。非表示タブでの復旧（バックアップ探索 → 再読み込み）はブラウザのタイマー抑制で
        // すでに遅くなっており、3 倍のバックオフはバックグラウンドのタブで広告が始まったときの
        // 「フォーカスを戻すまで読み込み中のまま」という停止（issue #129）をさらに悪化させる。これは完全な修正ではなく回避策であり、
        // バックグラウンドのメディアの優先度低下はブラウザ側の挙動である。コストはごくわずかで、非表示かつ広告中のときだけポーリングが速くなる。
        const shouldThrottle = typeof document !== 'undefined' && document.hidden && !document.pictureInPictureElement && !playerBufferState.inAdBreak;
        rescheduleDelay = shouldThrottle ? PlayerBufferingDelay * 3 : PlayerBufferingDelay;
        } finally {
            setTimeout(monitorPlayerBuffering, rescheduleDelay);
        }
    }
    // すでに広告をブロックしている場合は、Twitch の広告 / Turbo 宣伝 / 配信内ディスプレイ広告のオーバーレイを非表示にする
    function hideTwitchAdOverlays() {
        if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) return;
        // 配信内ディスプレイ広告（SDA）のラッパーを非表示にする
        const sdaElements = document.querySelectorAll('[data-test-selector="sda-wrapper"]');
        for (let i = 0; i < sdaElements.length; i++) {
            if (!sdaElements[i].dataset.tasHidden) {
                sdaElements[i].dataset.tasHidden = '';
                sdaElements[i].style.setProperty('display', 'none', 'important');
                if (!loggedSdaHide) {
                    loggedSdaHide = true;
                    console.log('[AD DEBUG] Twitch の配信内ディスプレイ広告を非表示にしました');
                }
            }
        }
        // 動画広告に対する独立したガード（GosuDRM/TTV-AB v12.0.1〜12.0.8、issue #249 に準拠）:
        // 2026 年 7 月以降、Twitch はプレイヤーの横やチャット内に独立した <video> の広告要素を描画するようになった。
        // 再生ボタン付きの、もう一つの「プレイヤー」である。これらは m3u8 の外部で配信されるため、
        // セグメントの除去でもバックアップへの切り替えでも手が届かない。
        // 一致条件は Amazon の広告 CDN のホストのみである。これが安全性の根拠になる: ライブ配信は
        // MediaSource から供給されて常に blob: の URL を持つため、メインのプレイヤーがこの条件に一致することはない。
        // プレイヤーが保持している要素は、2 つ目の独立したガードとして除外している。
        // 非表示にするだけでなくミュートと一時停止も行う。display:none の <video> でも音声は再生されるためである（TTV-AB v12.0.7）。
        const primaryVideo = playerForMonitoringBuffering?.player?.getHTMLVideoElement?.();
        const allVideos = document.getElementsByTagName('video');
        for (let i = 0; i < allVideos.length; i++) {
            const vid = allVideos[i];
            let adHost = '';
            try {
                const vidSrc = vid.currentSrc || vid.getAttribute('src') || '';
                if (vidSrc && !vidSrc.startsWith('blob:')) {
                    const host = new URL(vidSrc, document.location.href).hostname.toLowerCase();
                    if (host === 'media-amazon.com' || host.endsWith('.media-amazon.com')) {
                        adHost = host;
                    }
                }
            } catch {}
            if (adHost && vid !== primaryVideo) {
                // 1 度マークして終わりにせず、毎ティックで適用し直す: React の再描画は要素を残したまま
                // インラインのスタイルだけを落とすことがあり、単発のマーカー方式では二度と再適用されないためである。
                vid.style.setProperty('display', 'none', 'important');
                try { vid.muted = true; if (!vid.paused) vid.pause(); } catch {}
                if (!vid.dataset.tasAdHidden) {
                    vid.dataset.tasAdHidden = '';
                    console.log('[AD DEBUG] 独立した Twitch の動画広告を非表示にしました（' + adHost + '）— issue #249');
                }
            } else if (vid.dataset.tasAdHidden && !adHost) {
                // Twitch は <video> ノードを再利用する: 広告を保持していた要素が、後で本物のコンテンツを
                // 割り当てられることがある。これがないと display:none とミュートのまま固定され、コンテンツが
                // 見えなくなってしまう。メインかどうかの判定を条件にしていないのは意図的で、メインに昇格した
                // 要素も確実に復元されるようにするためである。TTV-AB v12.0.2（「Twitch が再利用する動画を安全に復元する」）に準拠。
                delete vid.dataset.tasAdHidden;
                vid.style.removeProperty('display');
                try { vid.muted = false; } catch {}
                console.log('[AD DEBUG] 再利用された <video> を復元しました — ソースはもう広告ではありません（#249）');
            }
        }
    }
    function updateAdblockBanner(data) {
        if (!cachedPlayerRootDiv || !cachedPlayerRootDiv.isConnected) {
            cachedPlayerRootDiv = document.querySelector('.video-player');
        }
        const playerRootDiv = cachedPlayerRootDiv;
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
                isActivelyStrippingAds = data.isStrippingAdSegments;
                adBlockDiv.P.textContent = (data.isMidroll ? 'ミッドロール' : '') + '広告をブロック中' + (data.isStrippingAdSegments ? '（除去中）' : '') + (data.activeBackupPlayerType ? '（' + data.activeBackupPlayerType + '）' : '');
                adBlockDiv.style.display = data.hasAds && playerBufferState.isLive ? 'block' : 'none';
            }
            if (data.hasAds) {
                hideTwitchAdOverlays();
            }
        }
    }
    // React の fiber ツリーをたどって Twitch のプレイヤーとプレイヤー状態のインスタンスを探す
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
            if (!cachedRootNode) {
                cachedRootNode = document.querySelector('#root');
            }
            const rootNode = cachedRootNode;
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer'));
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
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        // 「見つからない」という警告を出すまでの猶予期間。React がプレイヤーのマウントを終える前に
        // バッファ監視がティックすることがあり、ページを読み込むたびに 1 回だけ誤検知のログが出てしまう。
        // null の状態が 10 秒以上続いた場合のみログに出す。その時点なら React は確実にマウント済みであり、
        // null が続くのは本当に API が変わったこと（Twitch が setPlayerActive / setSrc などを改名したこと）を示す。
        if (!player) {
            if (!getPlayerAndState.firstPlayerNullAt) getPlayerAndState.firstPlayerNullAt = Date.now();
            if (!getPlayerAndState.loggedNoPlayer && (Date.now() - getPlayerAndState.firstPlayerNullAt) > 10000) {
                getPlayerAndState.loggedNoPlayer = true;
                console.log('[AD DEBUG] プレイヤーが 10 秒以上見つかりません — Twitch が setPlayerActive / mediaPlayerInstance を改名した可能性があります');
            }
        } else {
            getPlayerAndState.firstPlayerNullAt = 0;// 見つかったらリセットする
        }
        if (!playerState) {
            if (!getPlayerAndState.firstStateNullAt) getPlayerAndState.firstStateNullAt = Date.now();
            if (!getPlayerAndState.loggedNoState && (Date.now() - getPlayerAndState.firstStateNullAt) > 10000) {
                getPlayerAndState.loggedNoState = true;
                console.log('[AD DEBUG] プレイヤーの状態が 10 秒以上見つかりません — Twitch が setSrc / setInitialPlaybackSettings を改名した可能性があります');
            }
        } else {
            getPlayerAndState.firstStateNullAt = 0;// 見つかったらリセットする
        }
        return  {
            player: player,
            state: playerState
        };
    }
    // Apple のタッチデバイスの判定。iPadOS 13 以降は navigator.platform に 'MacIntel' を返し、UA も
    // デスクトップ版 Safari のものになるため、本物の Mac と区別できるのはタッチ対応の有無だけである
    // （本物の Mac は maxTouchPoints が 0）。iPhone / iPod / 古い iPadOS は platform をそのまま返す。
    const isAppleTouchDevice = (function() {
        try {
            const p = navigator.platform || '';
            if (/^(iPhone|iPad|iPod)/.test(p)) return true;
            return p === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
        } catch { return false; }
    })();
    // Apple のタッチデバイスでは、ハード再読み込みによってメディア要素が作り直され（setSrc の isNewMediaPlayerInstance）、
    // iOS / iPadOS はこれをユーザー操作に基づかないものとして扱うため play() が拒否される。その結果、黒画面と
    // ネイティブの再生アイコンが表示され、ユーザーがタップしなければならなくなる（issue: iPad で広告時に黒画面）。
    // ハード再読み込みをソフトに落とすことで、許可済みの既存の要素が再利用され、タップなしで再開できる。
    // 無効化するには twitchAdSolutions_iosSoftReload=false を設定する。
    const iosSoftReload = isAppleTouchDevice && (function() {
        try { return localStorage.getItem('twitchAdSolutions_iosSoftReload') !== 'false'; } catch { return true; }
    })();
    // 画質 / 音量の設定を保ったまま、Twitch のプレイヤーを一時停止 / 再生するか完全に再読み込みする
    function doTwitchPlayerTask(isPausePlay, isReload, reloadKind) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
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
        const wasPaused = player.isPaused() || player.core?.paused;
        // iOS / iPadOS での無駄な再読み込み防止（pixeltris 時代の「一時停止中なら中止する」再読み込みガードを、
        // Apple のタッチデバイスに限定して復活させたもの）: 再読み込みはメディア要素を作り直すため、iOS では
        // 再開にユーザーの操作が必要になる。プレイヤーがすでに一時停止しているときにこれを再発動しても、
        // ユーザーの指の下で黒画面 + 再生アイコンを作り直すだけである（「再生を押せない」）。一時停止した
        // 要素をそのまま残しておけば、1 回のタップで再開できる。iOS 向けの他の回避策とまとめて
        // twitchAdSolutions_iosSoftReload=false で無効化できる。
        if (isReload && iosSoftReload && wasPaused) {
            console.log('[AD DEBUG] iOS / iPadOS: 再読み込みをスキップします — プレイヤーはすでに一時停止しています（無駄な再読み込みの防止。タップで再開できます）');
            return;
        }
        // すでに一時停止している場合のみ一時停止 / 再生の切り替えをブロックする。再読み込みは許可したままにする
        if (isPausePlay && wasPaused) {
            // ユーザーが意図的に一時停止した場合はその意図を尊重し、自動的に再開しない
            if (playerBufferState.userPauseIntent) {
                if (!playerBufferState.loggedPauseIntent) {
                    playerBufferState.loggedPauseIntent = true;
                    console.log('[AD DEBUG] ユーザーの一時停止意図を尊重します — 自動再開をスキップします');
                }
                return;
            }
            // こちらが直近に一時停止 / 再生を行ったのにプレイヤーが停止したままなら、再度 play() を試す（自動再生ポリシーや広告状態の干渉で固まっている）
            if (playerBufferState.weJustPaused && (Date.now() - playerBufferState.weJustPaused) < 10000) {
                try { player.play()?.catch?.(() => {}); } catch {}
            }
            return;
        }
        if (!wasPaused) {
            playerBufferState.weJustPaused = 0;
        }
        playerBufferState.lastFixTime = Date.now();
        playerBufferState.numSame = 0;
        if (isPausePlay) {
            player.pause();
            player.play()?.catch?.(() => {});
            playerBufferState.weJustPaused = Date.now();
            return;
        }
        if (isReload) {
            // プレイヤーがすでに正常なら再読み込みを省略する。スムーズな再生を妨げないため。
            // ただしライブ端から大きく遅れている場合（長い広告の後など）は、遅延をリセットするために再読み込みする。
            const video = player.getHTMLVideoElement?.();
            if (video && video.readyState >= 3 && !video.paused && !video.ended) {
                let latencySec = 0;
                let latencyKnown = false;
                try {
                    if (video.seekable && video.seekable.length > 0) {
                        const seekableEnd = video.seekable.end(video.seekable.length - 1);
                        if (Number.isFinite(seekableEnd)) {
                            const calc = Math.max(0, seekableEnd - video.currentTime);
                            // 妥当性の上限: 1 時間を超える値は Media Source API から返る不正な値を示す
                            // （再読み込み直後、シーク可能範囲が過渡的な状態のときに見られる）。
                            if (calc < 3600) {
                                latencySec = calc;
                                latencyKnown = true;
                            }
                        }
                    }
                } catch (e) {}
                if (!latencyKnown) {
                    console.log('[AD DEBUG] 遅延が不明です（seekable を利用できません）— 再読み込みを続行します');
                } else if (latencySec > 7) {
                    console.log('[AD DEBUG] プレイヤーは再生中ですがライブから ' + latencySec.toFixed(1) + ' 秒遅れています — 遅延をリセットするため再読み込みします');
                } else {
                    console.log('[AD DEBUG] 再読み込みをスキップします — プレイヤーは正常です（readyState=' + video.readyState + '、再生中、遅延=' + latencySec.toFixed(1) + ' 秒）');
                    postTwitchWorkerMessage('ReloadSkipped');
                    return;
                }
            }
        }
        if (isReload) {
            // 再読み込み前にプレイヤー設定の LS のキーを退避する。下の setTimeout で復元する。
            // TTV-AB の _PLAYER_PREFERENCE_KEYS と同じ範囲をカバーする。
            const PRESERVED_LS_KEYS = ['video-quality', 'video-muted', 'volume', 'lowLatencyModeEnabled', 'persistenceEnabled'];
            const lsSnapshot = {};
            try {
                for (const k of PRESERVED_LS_KEYS) {
                    lsSnapshot[k] = localStorage.getItem(k);
                }
                if (localStorageHookFailed && player?.core?.state) {
                    localStorage.setItem('video-muted', JSON.stringify({default:player.core.state.muted}));
                    localStorage.setItem('volume', player.core.state.volume);
                }
                if (player?.core?.state?.quality?.group) {
                    localStorage.setItem('video-quality', JSON.stringify({default:player.core.state.quality.group}));
                }
            } catch {}
            playerBufferState.lastReloadAt = Date.now();
            playerBufferState.adStallStartAt = 0;// 古い停止のタイマーをクリアし、再読み込み後の readyState=0 が再読み込み前の停止のせいにされないようにする
            playerBufferState.userPauseIntent = false;
            playerBufferState.loggedPauseIntent = false;
            // playerForMonitoringBuffering は毎ティック取得し直すため、手動での無効化は不要
            // 'early'（広告中の脱出。新しいセッションは新しい広告判定の枠を得る）にはハード再読み込みを使う。
            // 'post-ad'（黒画面を伴う破棄のないスムーズな遷移）にはソフト再読み込みを使う。
            // Apple のタッチデバイスでは強制的にソフトにする。新しいメディアインスタンスは再開にユーザーのタップを要する（黒画面 + 再生アイコン）。
            const hardReload = reloadKind === 'early' && !iosSoftReload;
            if (reloadKind === 'early' && iosSoftReload) {
                console.log('[AD DEBUG] iOS / iPadOS: ハード再読み込みをソフトに切り替えます — メディア要素のユーザー操作の許可を保ちます（黒画面 + 再生アイコンでの停止を回避）。無効化: twitchAdSolutions_iosSoftReload=false');
            }
            console.log('[AD DEBUG] Twitch のプレイヤーを再読み込みします' + (hardReload ? '（ハード）' : '（ソフト）'));
            // ハード再読み込みの間は事前にミュートして MSE の破棄時のノイズを隠し、canplay で復元する。
            if (hardReload) {
                try {
                    const v = document.querySelector('video');
                    const wasInitiallyUnmuted = v && !v.muted;
                    // issue #200 の修正 v636 — 理由は vaft_testing.user.js を参照。
                    const shouldRecover = playerBufferState.vaftEverUnmuted && RecoverFromSilentMute;
                    const shouldSetup = v && (wasInitiallyUnmuted || shouldRecover);
                    console.log('[AD DEBUG] 事前ミュートの開始 — v=' + (v ? 'あり' : 'null') + '、v.muted=' + (v ? v.muted : '該当なし') + '、分岐=' + (v && !v.muted ? '事前ミュート' : (v && v.muted ? (shouldRecover ? 'ミュート済み・復旧する' : 'ミュート済み・尊重する') : '動画なし・スキップ')) + '、vaftEverUnmuted=' + !!playerBufferState.vaftEverUnmuted + '、RecoverFromSilentMute=' + RecoverFromSilentMute);
                    if (shouldSetup) {
                        if (wasInitiallyUnmuted) {
                            v.muted = true;
                        }
                        let done = false;
                        const restore = (sourceEvent) => {
                            if (done) return;
                            done = true;
                            document.removeEventListener('canplay', listener, true);
                            document.removeEventListener('playing', listener, true);
                            document.removeEventListener('loadeddata', listener, true);
                            try {
                                const cur = document.querySelector('video');
                                const trigger = sourceEvent && sourceEvent.type ? sourceEvent.type : 'safety-timeout(4000ms)';
                                const targetMatch = (sourceEvent && sourceEvent.target && sourceEvent.target.tagName === 'VIDEO') ? (cur === sourceEvent.target ? 'same' : 'different') : 'n/a';
                                console.log('[AD DEBUG] 復元 — trigger=' + trigger + '、cur=' + (cur ? 'あり' : 'null') + '、復元前の cur.muted=' + (cur ? cur.muted : '該当なし') + '、対象一致=' + targetMatch + '、開始時のミュート=' + (wasInitiallyUnmuted ? 'ミュート解除済み' : 'ミュート済み'));
                                // 動画広告用の独立したガードが抑制している要素のミュートは決して解除しない:
                                // `cur` は DOM で最初の <video> であり、サイドやチャットの広告である可能性がある（#249）。
                                if (cur && !cur.dataset.tasAdHidden) {
                                    cur.muted = false;
                                    playerBufferState.vaftEverUnmuted = true;
                                }
                                // こちらが事前に行ったミュートが `cur` とは別の要素に適用されていた場合は元に戻す。
                                // `cur` は DOM で最初に現れる <video> であり、こちらがミュートした要素とは限らない。
                                // Twitch がサイドやチャットの広告用に追加の <video> 要素を描画するようになったためである（#249）。
                                // また Firefox の PiP はブラウザネイティブのため、document.pictureInPictureElement による
                                // 再読み込みガードがそこでは発火しない（#248）。wasInitiallyUnmuted で条件を付けているので、
                                // こちらが設定したミュートしか解除されず、広告の動画のミュートを解除してしまうことはない。
                                // 古い要素が切り離される通常のハード再読み込みでは何もしない。
                                if (v && v !== cur && v.isConnected && v.muted && wasInitiallyUnmuted) {
                                    v.muted = false;
                                    console.log('[AD DEBUG] 復元 — 元の要素に残っていた事前ミュートを解除しました（cur が別の <video> を指していたため）— issue #248');
                                }
                            } catch {}
                        };
                        const listener = (e) => {
                            if (e.target && e.target.tagName === 'VIDEO') restore(e);
                        };
                        document.addEventListener('canplay', listener, true);
                        document.addEventListener('playing', listener, true);
                        document.addEventListener('loadeddata', listener, true);
                        setTimeout(() => restore(null), 4000);
                        setTimeout(() => {
                            try {
                                const cur = document.querySelector('video');
                                console.log('[AD DEBUG] 最終防衛線 @5500ms — cur=' + (cur ? 'あり' : 'null') + '、cur.muted=' + (cur ? cur.muted : '該当なし') + '、userPauseIntent=' + !!playerBufferState.userPauseIntent + '、復元の実行=' + done + '、開始時のミュート=' + (wasInitiallyUnmuted ? 'ミュート解除済み' : 'ミュート済み'));
                                if (cur && cur.muted && !cur.dataset.tasAdHidden) {
                                    if (playerBufferState.userPauseIntent) {
                                        console.log('[AD DEBUG] ハード再読み込みの最終防衛線をスキップしました — 5500ms の時点で要素はミュートですが userPauseIntent が立っています（MSE の破棄中の pause イベントによる誤検出の可能性 — issue #200 の後続対応）');
                                    } else {
                                        cur.muted = false;
                                        playerBufferState.vaftEverUnmuted = true;
                                        console.log('[AD DEBUG] ハード再読み込みの最終防衛線によるミュート解除を実行しました — 5500ms の時点でまだミュートでした（開始時: ' + (wasInitiallyUnmuted ? 'ミュート解除済みで、こちらが事前にミュートした' : '開始時点でミュート済み — Twitch による静かな再ミュートから復旧します') + '）');
                                    }
                                }
                                // restore() と同じく、漏れた事前ミュートを最終防衛線で捕捉する。#248 を参照。
                                if (v && v !== cur && v.isConnected && v.muted && wasInitiallyUnmuted
                                    && !playerBufferState.userPauseIntent) {
                                    v.muted = false;
                                    console.log('[AD DEBUG] 最終防衛線 — 元の要素に残っていた事前ミュートを解除しました（cur が別の <video> を指していたため）— issue #248');
                                }
                            } catch {}
                        }, 5500);
                    }
                } catch {}
            }
            // 再読み込みのウィンドウ中に、MSE の破棄による pause イベントが userPauseIntent を
            // 誤って立ててしまうのを防ぐ。v636（issue #200）に続く v637 の対応。
            if (hardReload) {
                playerBufferState.weJustPaused = Date.now();
            }
            playerState.setSrc({ isNewMediaPlayerInstance: hardReload, refreshAccessToken: hardReload });
            postTwitchWorkerMessage('TriggeredPlayerReload');
            // リトライ付きで再生を再開する。ユーザーが手動で一時停止していない場合のみ
            if (!wasPaused) {
                player.play()?.catch?.(() => {});
                // play() が効かなかった場合は再開を再試行する
                setTimeout(() => {
                    try {
                        if (player.isPaused() && !player.core?.paused) {
                            player.play()?.catch?.(() => {});
                        }
                    } catch {}
                }, 1500);
            }
            // 再読み込み後は必ずミュート / 音量の状態を復元する。Chrome の自動再生ポリシーによって強制的にミュートされることがあるため。
            // このブロックは常に実行する必要がある: Twitch がまだ LS に値を書き込んでいない場合（新規セッション、プライベートモード、
            // キャッシュ削除後）でも、再読み込み時に Chrome の自動再生ミュートが働くため、動画のミュート解除が必要になる。
            {
                setTimeout(() => {
                    try {
                        for (const [k, v] of Object.entries(lsSnapshot)) {
                            if (v !== null) {
                                localStorage.setItem(k, v);
                            }
                        }
                        const videos = document.getElementsByTagName('video');
                        // ユーザーのミュート意図を尊重する: LS がミュートを示していない場合のみ強制的にミュートを解除する。
                        // ユーザーが UI からミュートした場合、Twitch は video-muted に '{"default":true}' を書き込む。
                        // Chrome の自動再生ポリシーは、ユーザーが操作していなくてもミュートすることがある（LS には何も残らない）。
                        const userIntendedMute = lsSnapshot['video-muted']?.includes('"default":true');
                        if (videos.length > 0 && videos[0].muted && !userIntendedMute) {
                            videos[0].muted = false;
                        }
                        // 再読み込み後のライブとのずれを補正する。
                        // ずれが大きい（5 秒超）ハード再読み込みでは、ライブ端まで直接シークして、除去 + BLANK_MP4 + 復旧の
                        // 処理で生じた音声と映像のタイムスタンプのずれを解消する。1.1 倍速のドリフト補正では
                        // 30〜60 秒のずれを取り戻すのに何分もかかってしまう。
                        // ソフト再読み込みやずれが小さい場合は、従来どおり徐々に追いつく方式を使う。
                        if (videos.length > 0 && videos[0].buffered.length > 0 && videos[0].readyState >= 3) {
                            const liveEdge = videos[0].buffered.end(videos[0].buffered.length - 1);
                            const drift = liveEdge - videos[0].currentTime;
                            if (hardReload && drift > 5 && Number.isFinite(liveEdge) && liveEdge < 3600) {
                                console.log('[AD DEBUG] ハード再読み込み後のライブへのシーク — ' + drift.toFixed(1) + ' 秒遅れているため、音ズレを解消するようライブ端へ移動します');
                                videos[0].currentTime = liveEdge;
                            } else if (drift > 2) {
                                console.log('[AD DEBUG] 再読み込み後のライブとのずれの補正: ' + drift.toFixed(1) + ' 秒遅れ');
                                startDriftCorrection(videos[0]);
                            }
                        }
                    } catch {}
                }, 3000);
            }
            return;
        }
    }
    window.reloadTwitchPlayer = () => {
        doTwitchPlayerTask(false, true);
    };
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
            const responseBody = await response.text();
            // clearTimeout はボディの読み取りの後で行う（TTV-AB v9.6.1 に準拠）: 中断はヘッダーが遅い場合だけでなく、
            // ボディの途中で応答が止まる場合もカバーする必要がある。中断時、text() は AbortError で reject し、
            // 下の catch がタイマーをクリアする（すでに発火済みなら何もしない）。
            clearTimeout(timeoutId);
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
    // window スコープで fetch() をフックし、認証ヘッダーを取得してプレイヤータイプのリクエストを変更する
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
                    if (typeof deviceId === 'string' && GQLDeviceID != deviceId) {
                        GQLDeviceID = deviceId;
                        postTwitchWorkerMessage('UpdateDeviceId', GQLDeviceID);
                    }
                    if (typeof init.headers['Client-Version'] === 'string' && init.headers['Client-Version'] !== ClientVersion) {
                        postTwitchWorkerMessage('UpdateClientVersion', ClientVersion = init.headers['Client-Version']);
                    }
                    if (typeof init.headers['Client-Session-Id'] === 'string' && init.headers['Client-Session-Id'] !== ClientSession) {
                        postTwitchWorkerMessage('UpdateClientSession', ClientSession = init.headers['Client-Session-Id']);
                    }
                    if (typeof init.headers['Client-Integrity'] === 'string' && init.headers['Client-Integrity'] !== ClientIntegrityHeader) {
                        postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = init.headers['Client-Integrity']);
                    }
                    if (typeof init.headers['Authorization'] === 'string' && init.headers['Authorization'] !== AuthorizationHeader) {
                        postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = init.headers['Authorization']);
                    }
                    if (!hasLoggedHeaders && GQLDeviceID && AuthorizationHeader) {
                        hasLoggedHeaders = true;
                        console.log('[AD DEBUG] GQL のヘッダーを取得 — DeviceId: ' + (GQLDeviceID ? 'あり' : 'なし') + '、Auth: ' + (AuthorizationHeader ? 'あり' : 'なし') + '、Integrity: ' + (ClientIntegrityHeader ? 'あり' : 'なし'));
                    }
                    // チャット上部のミニプレイヤーを除去する - TODO: サーバー側で拒否させるのではなく、ローカルで拒否するようにする
                    if (init && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken') && init.body.includes('picture-by-picture')) {
                        init.body = '';
                    }
                    if (ForceAccessTokenPlayerType && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken')) {
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
                            console.log(`[AD DEBUG] プレイヤータイプ '${replacedPlayerType}' を '${ForceAccessTokenPlayerType}' に置き換えました`);
                            init.body = JSON.stringify(newBody);
                        }
                    }
                }
            }
            return realFetch.apply(this, arguments);
        }, 'fetch');
    }
    // 再読み込みをまたいでプレイヤーの状態を保持するため、可視状態の上書きと localStorage のフックを設定する
    function onContentLoaded() {
        if (document.getElementById('seventv-extension')) {
            console.log('[AD DEBUG] 警告: 7TV 拡張機能を検出しました — 黒画面やバッファリングの原因になることがあります。問題が起きる場合は 7TV を無効にしてみてください。');
        }
        // 非表示のタブで広告中に Twitch がプレイヤーを一時停止した場合、タブにフォーカスが戻ったら再開する。
        // 以前は document.hidden / visibilityState / hasFocus も偽装し、キャプチャフェーズでイベントを
        // 握りつぶしていた。しかしそれは実際の可視状態に依存する他の拡張機能（BetterTTV の
        // 「Mute Invisible Player」など）を壊していた。広告中の非表示→表示の遷移で再生を維持するには、
        // フォーカス時の再開だけで十分である。TTV-AB v6.5.0 と同期。
        let wasVideoPlaying = true;
        const visibilityChange = () => {
            const videos = document.getElementsByTagName('video');
            if (videos.length === 0) return;
            if (document.hidden) {
                wasVideoPlaying = !videos[0].paused && !videos[0].ended;
                return;
            }
            if (!playerBufferState.hasStreamStarted) {
                playerBufferState.hasStreamStarted = true;
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
    declareOptions(window);
    try {
        const lsReloadAfterAd = localStorage.getItem('twitchAdSolutions_reloadPlayerAfterAd');
        if (lsReloadAfterAd !== null) {
            ReloadPlayerAfterAd = lsReloadAfterAd === 'true';
        }
        const lsReloadCooldown = parseInt(localStorage.getItem('twitchAdSolutions_reloadCooldownSeconds'));
        if (!isNaN(lsReloadCooldown) && lsReloadCooldown >= 0) {
            ReloadCooldownSeconds = lsReloadCooldown;
        }
        const lsDisableReloadCap = localStorage.getItem('twitchAdSolutions_disableReloadCap');
        if (lsDisableReloadCap !== null) {
            DisableReloadCap = lsDisableReloadCap === 'true';
        }
        const lsDriftRate = parseFloat(localStorage.getItem('twitchAdSolutions_driftCorrectionRate'));
        if (!isNaN(lsDriftRate) && lsDriftRate >= 0) {
            DriftCorrectionRate = lsDriftRate;
        }
        const lsEarlyReload = parseInt(localStorage.getItem('twitchAdSolutions_earlyReloadPollThreshold'));
        if (!isNaN(lsEarlyReload) && lsEarlyReload >= 0) {
            EarlyReloadPollThreshold = lsEarlyReload;
        }
        const lsDisableAdSpoofing = localStorage.getItem('twitchAdSolutions_disableAdSpoofing');
        if (lsDisableAdSpoofing !== null) {
            DisableAdSpoofing = lsDisableAdSpoofing === 'true';
        }
        if (!DisableAdSpoofing) {
            const spoofSrc = (lsDisableAdSpoofing === 'false') ? 'localStorage opt-in' : 'modified default';
            console.log('[AD DEBUG] AdSpoofing が有効です（' + spoofSrc + '）— 広告ありのポーリングのたびに GQL の広告トラッキングのビーコンを送信します。v68.3.0 以降のデフォルトは無効で、これは A/B 検証用のオプトインです。「広告完了をスプーフしました」の行にあるセッション累計を、同じチャンネルでスプーフを無効にしたセッションと比較してください。');
        }
        const lsPlayerType = localStorage.getItem('twitchAdSolutions_playerType');
        if (lsPlayerType !== null) {
            ForceAccessTokenPlayerType = lsPlayerType;
        }
        const lsPinBackup = localStorage.getItem('twitchAdSolutions_pinBackupPlayerType');
        if (lsPinBackup !== null) {
            PinBackupPlayerType = lsPinBackup === 'true';
        }
        const lsPreferLow = localStorage.getItem('twitchAdSolutions_preferLowQualityBackup');
        if (lsPreferLow === 'false') {
            PreferLowQualityBackup = false;
            console.log('[AD DEBUG] PreferLowQualityBackup が localStorage で無効化されています — スティッキー CSAI 経路のみで、autoplay へのフォールバックも脱出処理も行いません');
        }
        const lsFastAutoplay = localStorage.getItem('twitchAdSolutions_fastAutoplayFirstTry');
        if (lsFastAutoplay === 'false') {
            FastAutoplayFirstTry = false;
            console.log('[AD DEBUG] FastAutoplayFirstTry が localStorage で無効化されています');
        }
        const lsBackupSwapFirst = localStorage.getItem('twitchAdSolutions_backupSwapFirst');
        if (lsBackupSwapFirst === 'false') {
            BackupSwapFirst = false;
            console.log('[AD DEBUG] BackupSwapFirst が localStorage で無効化されています — スティッキー CSAI 経路を使用します（ネイティブのストリームで除去）');
        }
        const lsRecoverFromSilentMute = localStorage.getItem('twitchAdSolutions_recoverFromSilentMute');
        if (lsRecoverFromSilentMute === 'false') {
            RecoverFromSilentMute = false;
            console.log('[AD DEBUG] RecoverFromSilentMute が localStorage で無効化されています — ハード再読み込みの最終防衛線はミュート済みの状態を尊重します');
        }
        const lsSoftReloadNoStrip = localStorage.getItem('twitchAdSolutions_softReloadNoStrip');
        if (lsSoftReloadNoStrip === 'false') {
            SoftReloadNoStrip = false;
            console.log('[AD DEBUG] SoftReloadNoStrip が localStorage で無効化されています — 除去のない CSAI の広告でも、広告後の再読み込みは常にハードになります（issue #129 の A/B 検証）');
        }
        const lsDisableInAdGapSeek = localStorage.getItem('twitchAdSolutions_disableInAdGapSeek');
        if (lsDisableInAdGapSeek === 'true') {
            DisableInAdGapSeek = true;
            console.log('[AD DEBUG] 広告中のバッファの空白のシークが localStorage で無効化されています — 広告の途中で空白にフリーズしたバックアップはシークされません（A/B 検証のための切り分け）');
        }
        const lsDisableInAdFreezeReload = localStorage.getItem('twitchAdSolutions_disableInAdFreezeReload');
        if (lsDisableInAdFreezeReload === 'true') {
            DisableInAdFreezeReload = true;
            console.log('[AD DEBUG] 広告中の再生位置フリーズによる再読み込みへの段階的移行が localStorage で無効化されています — フリーズした固定バックアップは再読み込みされません（A/B 検証のための切り分け）');
        }
        const lsDisablePostBreakWedge = localStorage.getItem('twitchAdSolutions_disablePostBreakWedge');
        if (lsDisablePostBreakWedge === 'true') {
            DisablePostBreakWedge = true;
            console.log('[AD DEBUG] 広告終了後の映像の詰まりからの復旧が localStorage で無効化されています — 広告後に音声のみ動作し映像がフリーズした状態は自動復旧されません（A/B 検証のための切り分け）');
        }
        const lsHideAdOverlay = localStorage.getItem('twitchAdSolutions_hideAdOverlay');
        if (lsHideAdOverlay === 'true') {
            const style = document.createElement('style');
            style.textContent = '.tas-adblock-overlay { display: none !important; }';
            (document.head || document.documentElement).appendChild(style);
        }
    } catch {}
    console.log('[AD DEBUG] 設定: ReloadPlayerAfterAd = ' + ReloadPlayerAfterAd + ', ForceAccessTokenPlayerType = ' + ForceAccessTokenPlayerType + ', PinBackupPlayerType = ' + PinBackupPlayerType);
    hookWindowWorker();
    hookFetch();
    if (PlayerBufferingFix) {
        monitorPlayerBuffering();
    }
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
