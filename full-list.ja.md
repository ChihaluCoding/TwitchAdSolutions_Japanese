*[English](full-list.md) / 日本語*

## Twitch Turbo

- `Twitch Turbo` - https://www.twitch.tv/turbo
  - 月額 $11.99 で、サードパーティの拡張機能やスクリプトを使わずにすべての配信を広告なしで視聴できます
  - Twitch というサイトの存続に貢献する唯一の広告ブロック手段です

## ウェブブラウザ拡張機能

- `TTV LOL PRO` - [chrome](https://chrome.google.com/webstore/detail/ttv-lol-pro/bpaoeijjlplfjbagceilcgbkcdjbomjd) / [firefox](https://addons.mozilla.org/addon/ttv-lol-pro/) / [コード](https://github.com/younesaassila/ttv-lol-pro)
  - `TTV LOL` 拡張機能のフォークで、広告ブロック性能が大幅に改善されています。
  - uBlock Origin との併用を推奨します。
  - **注意: オリジナルの TTV LOL 向けのプロキシとは互換性がありません。**
- `TTV LOL PRO (v1)` - [コード](https://github.com/younesaassila/ttv-lol-pro/tree/v1)
  - `TTV LOL PRO` の古い非推奨バージョンで、TTV LOL 互換のプロキシを引き続き使用します。現行バージョンで問題が発生していて、かつ内容を理解している場合のみ使用してください。
- `Alternate Player for Twitch.tv` - [chrome](https://chrome.google.com/webstore/detail/alternate-player-for-twit/bhplkbgoehhhddaoolmakpocnenplmhf) / [firefox](https://addons.mozilla.org/en-US/firefox/addon/twitch_5/)
  - 広告セグメントを除去します（広告のないストリームが見つかるまで再生されません）。ミッドロール広告中に低解像度のストリームが利用可能な場合はそれを使用できます。
- `Purple AdBlock` - [chrome](https://chrome.google.com/webstore/detail/purple-adblock/lkgcfobnmghhbhgekffaadadhmeoindg) / [firefox](https://addons.mozilla.org/en-US/firefox/addon/purpleadblock/) / [ユーザースクリプト](https://raw.githubusercontent.com/arthurbolsoni/Purple-adblock/refs/heads/main/platform/tampermonkey/dist/purpleadblocker.user.js) / [コード](https://github.com/arthurbolsoni/Purple-adblock/)
  - 広告セグメントを広告なしのセグメントに置き換えます。プロキシへのフォールバックも利用できます。どちらの方法も失敗した場合は広告セグメントを除去します（広告のないストリームが見つかるまで再生されません）。
- `AdGuard Extra` - [chrome](https://chrome.google.com/webstore/detail/adguard-extra-beta/mglpocjcjbekdckiahfhagndealpkpbj) / [firefox](https://github.com/AdguardTeam/AdGuardExtra/#firefox) / [ユーザースクリプト](https://userscripts.adtidy.org/release/adguard-extra/1.0/adguard-extra.user.js)
  - `vaft` からフォークされたもので、`vaft` と同様の挙動をします。できるだけ早く高解像度のクリーンなストリームの取得を試みます。
- `TTV Ad Mute` - [firefox](https://addons.mozilla.org/en-US/firefox/addon/twitch-tv-ad-mute/) / [コード](https://github.com/drj101687/ttv-ad-mute)
  - 該当タブで広告の再生が始まると、自動的にミュート / ミュート解除します。
  - 広告再生中は広告プレイヤーを黒いボックスで覆います。
  - ブラウザのタブをミュートする方式のため、配信者の指標に悪影響を与えず、Twitch ドロップスが無効化されることもありません。

---

*ソースからのビルドが必要*

- `luminous-ttv` - [サーバーのコード](https://github.com/AlyoshaVasilieva/luminous-ttv) / [拡張機能のコード](https://github.com/AlyoshaVasilieva/luminous-ttv-ext)
  - メインの m3u8 ファイルにプロキシを使用して、広告のないストリームを取得します。

## ウェブブラウザのスクリプト（ユーザースクリプト）

- https://greasyfork.org/en/scripts/371186-twitch-mute-ads-and-optionally-hide-them/code
  - 広告をミュートし、任意で非表示にします（スクリプト冒頭の設定で調整できます）。
- `vaft` - [ユーザースクリプト](https://github.com/pixeltris/TwitchAdSolutions/raw/master/vaft/vaft.user.js)
  - できるだけ早くクリーンなストリームの取得を試みます。
  - クリーンなストリームを取得できない場合は広告セグメントを除去します（広告のないストリームが見つかるまで再生されません）。
- `video-swap-new` - [ユーザースクリプト](https://github.com/pixeltris/TwitchAdSolutions/raw/master/video-swap-new/video-swap-new.user.js)
  - クリーンなストリーム（低解像度）の取得を試みます。
  - クリーンなストリームを取得できない場合は広告セグメントを除去します（広告のないストリームが見つかるまで再生されません）。
  - 非推奨です。`vaft` の方が優れたスクリプトです。
- `strip` - [ユーザースクリプト](https://github.com/pixeltris/TwitchAdSolutions/raw/master/strip/strip.js)
  - 広告セグメントを除去します（広告のないストリームが見つかるまで再生されません）。
  - 非推奨です。`vaft` の方が優れたスクリプトです。

## アプリケーション / サードパーティのウェブサイト
- `streamlink` - [コード](https://github.com/streamlink/streamlink) / [ウェブサイト](https://streamlink.github.io/streamlink-twitch-gui/)
  - 広告セグメントを除去します（広告のないストリームが見つかるまで再生されません）。
  - 途切れない再生には[この](https://github.com/2bc4/streamlink-ttvlol)改変ファイルを使用してください。
- `Xtra for Twitch`（フォーク） - [apk](https://github.com/crackededed/Xtra/releases) / [コード](https://github.com/crackededed/Xtra)
  - 広告ブロックを含む追加機能を備えた Android 向けの代替 Twitch プレイヤーです。現在はプロキシに TTV LOL API のみを使用しています。ただし TTV LOL 自体はすでに動作しないため、広告ブロック機能を使うには設定でカスタムのプロキシ URL を入力する必要があります。例: `https://eu.luminous.dev/live/$channel?allow_source=true&allow_audio_only=true&fast_bread=true`
- `ReVanced` - [コード](https://github.com/revanced)
  - Twitch や YouTube などの Android アプリにパッチを当てて広告を除去できるツール群です。ReVanced の Twitch 用パッチは TTV LOL と PurpleAdBlocker のプロキシを使用します（設定で切り替え可能）。セットアップが複雑なので、手間をかけたくない場合は Xtra を使う方がよいでしょう。
- https://github.com/level3tjg/TwitchAdBlock
  - iOS で Twitch の広告をブロックします
- https://reddit.com/r/Twitch/comments/kisdsy/i_did_a_little_test_regarding_ads_on_twitch_and/
  - 一部の国では広告が配信されません。すべての通信をプロキシせずに、最初の m3u8 だけをプロキシすることで、シンプルな VPN / VPS を広告ブロックに利用できます。

## プロキシの問題

プロキシを使う方法ではダウンタイムが発生することがあり、その場合は広告が表示されるかエラー 2000 が出ます。これは Twitch による報復ではありません。

高解像度ではバッファリングが発生することがあります。これは、最初の m3u8 のリクエストを行ったプロキシに最も近い Twitch サーバーからトラフィックが配信されるためです。唯一の解決策は、プロキシの管理者に自分の国により近いプロキシを追加してもらうことです。それが難しい場合は、低い解像度を使うか、別の広告ブロック手段を使う必要があります。VPN の方が適している場合もあります。

## ウェブブラウザ拡張機能（メンテナンス終了）

- `TTV LOL` - [chrome](https://chrome.google.com/webstore/detail/ttv-lol/ofbbahodfeppoklmgjiokgfdgcndngjm) / [コード](https://github.com/TTV-LOL/extensions)
  - メインの m3u8 ファイルにプロキシを使用して、広告のないストリームを取得します。
- `Video Ad-Block, for Twitch`（フォーク） - [コード](https://github.com/cleanlock/VideoAdBlockForTwitch)
  - 広告セグメントを広告なしのセグメントに置き換えます。ローカルでの広告なしストリーム取得に失敗した場合、広告セグメント中のプロキシへのフォールバックをオプトインで利用できます。すべての方法が失敗した場合は広告ブロッカーの警告を表示します。
- `ttv_adEraser` - [chrome](https://chrome.google.com/webstore/detail/ttv-aderaser/pjnopimdnmhiaanhjfficogijajbhjnc) / [firefox（手動インストール）](https://github.com/LeonHeidelbach/ttv_adEraser#mozilla-firefox) / [コード](https://github.com/LeonHeidelbach/ttv_adEraser)
  - 広告が入ると `embed` プレイヤーに切り替えます。広告と紫画面が同時に発生した場合、紫画面が表示されることがあるようです。
- `ttv-tools` - [firefox（手動インストール）](https://github.com/Nerixyz/ttv-tools/releases) / [コード](https://github.com/Nerixyz/ttv-tools)
  - 広告セグメントを除去します（広告のないストリームが見つかるまで再生されません）。

## ウェブブラウザのスクリプト（ユーザースクリプト）（メンテナンス終了）

- https://greasyfork.org/en/scripts/415412-twitch-refresh-on-advert/code
  - DOM 内に広告バナーを検出すると、プレイヤー（またはページ）を再読み込みします。
