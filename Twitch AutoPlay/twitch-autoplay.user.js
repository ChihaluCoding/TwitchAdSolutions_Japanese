// ==UserScript==
// @name         Twitch AutoPlay
// @namespace    https://github.com/pixeltris/TwitchAdSolutions
// @version      1.2.0
// @description  Twitchの再生が一時停止したら自動で再生を再開する
// @author       himarry
// @match        https://www.twitch.tv/*
// @match        https://m.twitch.tv/*
// @match        https://player.twitch.tv/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ---- 設定 (localStorage で上書き可) ----
    // twitchAutoPlay_pollInterval    — 監視間隔(ms), 既定 400
    // twitchAutoPlay_resumeDelay     — 通常時の猶予(ms), 既定 0 (即時再生)
    // twitchAutoPlay_switchDelay     — ソース差し替え中と判定したときの猶予(ms), 既定 600
    // twitchAutoPlay_respectUserPause— 'true' ならユーザーの手動一時停止を尊重, 既定 'true'
    // twitchAutoPlay_maxAttempts     — 連続失敗の上限, 既定 5
    // twitchAutoPlay_debug           — 'true' でログ出力, 既定 'false'
    function cfg(key, fallback) {
        try {
            const v = localStorage.getItem('twitchAutoPlay_' + key);
            return v === null ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }
    function cfgInt(key, fallback) {
        const n = parseInt(cfg(key, String(fallback)), 10);
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    }
    const POLL_INTERVAL = cfgInt('pollInterval', 400) || 400;
    const RESUME_DELAY = cfgInt('resumeDelay', 0);
    const SWITCH_DELAY = cfgInt('switchDelay', 600);
    const CLICK_COOLDOWN = cfgInt('clickCooldown', 1000);
    const RESPECT_USER_PAUSE = cfg('respectUserPause', 'true') !== 'false';
    const MAX_ATTEMPTS = cfgInt('maxAttempts', 5) || 5;
    const DEBUG = cfg('debug', 'false') === 'true';

    function log() {
        if (!DEBUG) return;
        console.log.apply(console, ['[AUTOPLAY]'].concat(Array.prototype.slice.call(arguments)));
    }

    // ---- 状態 ----
    // ユーザーが再生ボタン周辺を操作した直後かどうか。
    // Twitch や vaft がスクリプト的に pause() した場合は入力イベントが伴わないので、
    // 「直前に本物のユーザー入力があったか」で手動一時停止を判別する。
    let lastUserInputAt = 0;
    const USER_INPUT_WINDOW = 800; // ms
    let userPausedIntent = false;
    let attempts = 0;
    let pendingResume = null;
    const seen = new WeakSet();

    function markUserInput() {
        lastUserInputAt = Date.now();
    }
    // isTrusted なイベントのみ = 実際の人間の操作
    ['pointerdown', 'keydown'].forEach(function(type) {
        document.addEventListener(type, function(e) {
            if (e.isTrusted) markUserInput();
        }, true);
    });

    function isRecentUserInput() {
        return Date.now() - lastUserInputAt < USER_INPUT_WINDOW;
    }

    // 広告処理中など、再生を邪魔してはいけない状況を除外する
    function shouldSkip(video) {
        // 動画ソースがまだ無い
        if (!video.src && !video.currentSrc) return 'no source';
        // 再生終了 (VOD の末尾)
        if (video.ended) return 'ended';
        // ユーザーが意図的に止めた
        if (RESPECT_USER_PAUSE && userPausedIntent) return 'user paused';
        return null;
    }

    function tryResume(video, reason) {
        const skip = shouldSkip(video);
        if (skip) {
            log('skip resume (' + skip + ') reason=' + reason);
            return;
        }
        if (attempts >= MAX_ATTEMPTS) {
            log('attempt limit reached, giving up until next successful play');
            return;
        }
        attempts++;
        log('resuming (' + reason + ') attempt ' + attempts);
        const p = video.play();
        if (p && typeof p.catch === 'function') {
            p.catch(function(err) {
                // 自動再生ポリシーによる拒否。ミュートすれば通ることが多い。
                log('play() rejected:', err && err.name);
                if (err && err.name === 'NotAllowedError' && !video.muted) {
                    log('muting and retrying due to autoplay policy');
                    video.muted = true;
                    video.play().catch(function(e2) {
                        log('muted retry also failed:', e2 && e2.name);
                        clickPlayButton('play() fallback');
                    });
                    return;
                }
                clickPlayButton('play() fallback');
            });
        }
    }

    // Twitch の再生/一時停止ボタン。data-a-player-state が 'paused' のときだけ
    // 「再生」ボタンとして機能しているので、それを条件にする。
    // (同じボタンが再生中は一時停止ボタンになるため、状態を見ないと止めてしまう)
    function findPlayButton() {
        const buttons = document.querySelectorAll('[data-a-target="player-play-pause-button"]');
        for (let i = 0; i < buttons.length; i++) {
            if (buttons[i].getAttribute('data-a-player-state') === 'paused') {
                return buttons[i];
            }
        }
        return null;
    }

    // video.play() は自動再生ポリシーで拒否されることがあるが、
    // ボタンのクリックは Twitch 自身のハンドラを通るので成功しやすい。
    function clickPlayButton(reason) {
        const button = findPlayButton();
        if (!button) return false;
        if (button.dataset.tasAutoplayClickedAt) {
            // 同じボタンを連打しない (Twitch の状態更新を待つ)
            const since = Date.now() - parseInt(button.dataset.tasAutoplayClickedAt, 10);
            if (since < CLICK_COOLDOWN) {
                log('play button click on cooldown (' + since + 'ms)');
                return false;
            }
        }
        button.dataset.tasAutoplayClickedAt = String(Date.now());
        log('clicking play button (' + reason + ')');
        button.click();
        return true;
    }

    // ソースの差し替え中か (vaft のバックアップ player type スワップ、リロード、
    // 広告切替など)。この最中に play() を割り込ませても再生できず、
    // 失敗回数を無駄に消費するだけなので少し待つ。
    // HAVE_CURRENT_DATA(2) 未満 = 現在位置のフレームすら持っていない。
    function isSwitchingSource(video) {
        return video.readyState < 2 || video.networkState === 2 /* NETWORK_LOADING */ && video.readyState === 0;
    }

    function scheduleResume(video, reason) {
        if (pendingResume) {
            clearTimeout(pendingResume);
            pendingResume = null;
        }
        const delay = isSwitchingSource(video) ? SWITCH_DELAY : RESUME_DELAY;
        if (delay <= 0) {
            // 通常の一時停止は即座に再生を再開する
            tryResume(video, reason);
            return;
        }
        pendingResume = setTimeout(function() {
            pendingResume = null;
            if (video.paused) tryResume(video, reason);
        }, delay);
    }

    function attach(video) {
        if (seen.has(video)) return;
        seen.add(video);
        log('attached to video element');

        video.addEventListener('pause', function() {
            // pause イベントの直前に人間の入力があったなら手動一時停止とみなす
            if (RESPECT_USER_PAUSE && isRecentUserInput()) {
                userPausedIntent = true;
                log('user pause detected, standing down');
                return;
            }
            scheduleResume(video, 'pause event');
        });

        video.addEventListener('play', function() {
            // 手動であれ自動であれ再生が始まったら意図と失敗回数をリセット
            userPausedIntent = false;
            attempts = 0;
            if (pendingResume) {
                clearTimeout(pendingResume);
                pendingResume = null;
            }
        });

        // 再生が始まったのに実際には進んでいない場合の保険
        video.addEventListener('playing', function() {
            attempts = 0;
        });

        // 差し替え待ちで見送った分を、データが揃った瞬間に拾い直す。
        // ポーリングを待たずに済むので体感が速くなる。
        ['loadeddata', 'canplay'].forEach(function(type) {
            video.addEventListener(type, function() {
                if (!video.paused) return;
                if (RESPECT_USER_PAUSE && userPausedIntent) return;
                attempts = 0;
                scheduleResume(video, type);
            });
        });
    }

    function scan() {
        const videos = document.querySelectorAll('video');
        for (let i = 0; i < videos.length; i++) {
            attach(videos[i]);
        }
        return videos;
    }

    // ボタンが「一時停止中」を示していれば押す。
    // video 要素がまだ無い読み込み中でも成立するので、scan() とは独立して呼ぶ。
    function checkPlayButton(reason) {
        if (RESPECT_USER_PAUSE && userPausedIntent) return;
        if (!findPlayButton()) return;
        clickPlayButton(reason);
    }

    // DOM の差し替え (チャンネル移動・プレイヤー再生成) を拾う。
    // 属性変化も監視して、data-a-player-state が 'paused' になった瞬間に反応する。
    const observer = new MutationObserver(function() {
        scan();
        checkPlayButton('mutation');
    });

    function start() {
        scan();
        checkPlayButton('start');
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-a-player-state']
        });

        // イベントを取りこぼした場合の定期チェック。
        // vaft のリロード時など pause イベントが発火しないケースを拾う。
        setInterval(function() {
            const videos = scan();
            for (let i = 0; i < videos.length; i++) {
                const video = videos[i];
                if (video.paused && !pendingResume) {
                    if (RESPECT_USER_PAUSE && userPausedIntent) continue;
                    scheduleResume(video, 'poll');
                }
            }
            // video が無い/取得できない段階でもボタンだけで復帰させる
            checkPlayButton('poll');
        }, POLL_INTERVAL);

        // タブに戻ってきたときは失敗回数をリセットして再挑戦させる
        document.addEventListener('visibilitychange', function() {
            if (!document.hidden) {
                attempts = 0;
                checkPlayButton('visibility');
            }
        });
    }

    // document-start で読み込まれるため documentElement は既に存在する。
    // DOMContentLoaded を待つと読み込み中の一時停止を取りこぼすので即座に開始する。
    start();
})();
