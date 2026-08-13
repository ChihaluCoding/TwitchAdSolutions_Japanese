# TwitchAdSolutions 日本語版

このリポジトリは、Twitch の広告をブロックするための複数の手段を提供することを目的としています。

[ryanbr/TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions)（原作: [pixeltris](https://github.com/pixeltris/TwitchAdSolutions)）の非公式な日本語版です。ログやコメントを日本語化したうえで、一時停止からの自動復帰機能を追加しています。

**Twitch 専用の広告ブロッカーを併用しないでください。**

## 推奨

広告を回避する最も確実な方法はプロキシです（ただしバッファリングやダウンタイムが発生することがあります）。

- `TTV LOL PRO` - [chrome](https://chrome.google.com/webstore/detail/ttv-lol-pro/bpaoeijjlplfjbagceilcgbkcdjbomjd) / [firefox](https://addons.mozilla.org/addon/ttv-lol-pro/) / [コード](https://github.com/younesaassila/ttv-lol-pro)

その他の選択肢:

- `Twitch Turbo` - https://www.twitch.tv/turbo
- `Alternate Player for Twitch.tv` - [chrome](https://chrome.google.com/webstore/detail/alternate-player-for-twit/bhplkbgoehhhddaoolmakpocnenplmhf) / [firefox](https://addons.mozilla.org/en-US/firefox/addon/twitch_5/)
- `AdGuard Extra` - [chrome](https://chrome.google.com/webstore/detail/adguard-extra-beta/mglpocjcjbekdckiahfhagndealpkpbj) / [firefox](https://github.com/AdguardTeam/AdGuardExtra/#firefox) / [ユーザースクリプト](https://userscripts.adtidy.org/release/adguard-extra/1.0/adguard-extra.user.js)
- `vaft` - 下記参照

[@zGato がメンテナンスしているこちらの一覧も参照してください。](https://github.com/zGato/ScrewTwitchAds)

## インストール

**`vaft` を推奨します。** 下のリンクをクリックすると Tampermonkey のインストール画面が開きます。

### vaft（推奨）

[**➡ ユーザースクリプトをインストール**](https://github.com/ChihaluCoding/TwitchAdSolutions_Japanese/raw/main/vaft/vaft.user.js)

- できるだけ早くクリーンなストリームの取得を試みます
- クリーンなストリームを取得できない場合は広告セグメントを除去します（広告のないストリームが見つかるまで再生されません）
- 一時停止した際に自動で再生を再開します（本リポジトリ独自の追加機能）

uBlock Origin 版: [vaft-ublock-origin.js](https://raw.githubusercontent.com/ChihaluCoding/TwitchAdSolutions_Japanese/main/vaft/vaft-ublock-origin.js)

### その他

- video-swap-new - [ユーザースクリプト](https://github.com/ChihaluCoding/TwitchAdSolutions_Japanese/raw/main/video-swap-new/video-swap-new.user.js) / [ublock](https://raw.githubusercontent.com/ChihaluCoding/TwitchAdSolutions_Japanese/main/video-swap-new/video-swap-new-ublock-origin.js)
  - クリーンなストリームの取得を試みます
  - クリーンなストリームを取得できない場合は広告セグメントを除去します
  - 非推奨です。`vaft` の方が優れたスクリプトです
- strip - [ユーザースクリプト](https://github.com/ChihaluCoding/TwitchAdSolutions_Japanese/raw/main/strip/strip.user.js)
  - 広告セグメントを除去するだけの最小構成です。CSAI 広告には対応できないため非推奨です
- twitch-brave-fix - [ユーザースクリプト](https://github.com/ChihaluCoding/TwitchAdSolutions_Japanese/raw/main/vaft/twitch-brave-fix.user.js)
  - Brave ブラウザ向けの補助スクリプトです

**複数のスクリプトを同時に入れないでください。** 競合して動作しなくなります。

## スクリプトの適用方法（uBlock Origin）

- uBlock Origin のダッシュボード（拡張機能のオプション）を開きます
- `My filters`（自分のフィルター）タブで `twitch.tv##+js(twitch-videoad)` を追加します
- `Settings`（設定）タブで `I am an advanced user`（上級者です）を有効にし、表示される歯車アイコンをクリックします。`userResourcesLocation` の値を `unset` から、使用したいソリューションの完全な URL に変更します（すでに URL が設定されている場合は、既存の URL の後にスペースを追加してから記述します）。例: `userResourcesLocation https://raw.githubusercontent.com/ChihaluCoding/TwitchAdSolutions_Japanese/main/vaft/vaft-ublock-origin.js`
- uBlock Origin にスクリプトを確実に読み込ませるため、uBlock Origin 拡張機能の無効化 / 有効化（またはブラウザの再起動）を推奨します

スクリプトの使用をやめるには、フィルターを削除し、URL を `unset` に戻します。

*セキュリティの観点から、uBlock Origin ではパーマリンクの使用を推奨します（パーマリンクは自動更新されません）。*

*スクリプトは__原因不明の理由で uBlock Origin から適用されなくなることがあります__（[#200](https://github.com/pixeltris/TwitchAdSolutions/issues/200)）。代わりにユーザースクリプト版の使用を推奨します。*

## スクリプトの適用方法（ユーザースクリプト）

ユーザースクリプトマネージャーをインストールした状態でユーザースクリプトのファイルを開くと、そのスクリプトの追加を求めるプロンプトが表示されます。

ユーザースクリプトマネージャー:

- https://violentmonkey.github.io/
- https://www.tampermonkey.net/
- https://apps.apple.com/us/app/userscripts/id1463298887

*Greasemonkey はこれらのスクリプトでは動作しません。*

## 設定

スクリプトは `localStorage` による実行時設定に対応しています。ブラウザのコンソールで値を設定し、ページを再読み込みしてください。

**`twitchAdSolutions_reloadPlayerAfterAd`**（デフォルト: `true`）
- `true` - 広告後にプレイヤーを完全に再読み込みします（遅いが確実）
- `false` - 広告後に一時停止 / 再生を行います（速いが確実性は低い）
- 未設定 - デフォルト（`true`）を使用します

**`twitchAdSolutions_playerType`**（デフォルト: `popout`）
- アクセストークンのリクエストに使用するプレイヤータイプを変更します
- `popout` - ポップアウトプレイヤーのコンテキスト。広告が少ない傾向があります（デフォルト）
- `embed` - 埋め込みプレイヤーのコンテキスト。サードパーティサイトで使用されます
- `site` - 通常のサイトプレイヤー。標準的な Twitch の挙動（広告が最も多い）
- `autoplay` - 自動再生のコンテキスト。低画質（360p）
- 未設定 - デフォルト（`popout`）を使用します

**`twitchAdSolutions_hideAdOverlay`**（デフォルト: 未設定）
- `true` - 動画プレイヤー上の「広告をブロック中」バナーオーバーレイを非表示にします
- 未設定 - 広告ブロック中にバナーを表示します（デフォルト）

**`twitchAdSolutions_pinBackupPlayerType`**（デフォルト: `false`）
- `true` - 成功したバックアップのプレイヤータイプを記憶し、次回の広告時に最初に試します（バックアップ探索の時間を短縮）
- `false` - 常にバックアップタイプを最初から順に試します（デフォルト）
- ⚠ **画質に関する注意**: 記憶されたタイプが `autoplay` の場合、ソース画質のバックアップが利用できたはずの場面でも、広告中のバックアップが 360p のままになります。バックアップの画質よりも広告時の挙動の一貫性を優先する場合のみ有効にしてください。

**`twitchAdSolutions_reloadCooldownSeconds`**（デフォルト: `30`）
- 広告後のプレイヤー再読み込みの最小間隔（秒）
- 再読み込みが引き金となって Twitch がさらに広告を配信する CSAI（クライアントサイド広告挿入）の連鎖を防ぎます
- `0` に設定するとクールダウンを無効化します

**`twitchAdSolutions_disableReloadCap`**（デフォルト: 未設定）
- `true` - バッファ監視による再読み込みを無制限に行います（v47 以前の挙動。再読み込みループのリスクあり）
- 未設定 - バッファ監視による再読み込みを復旧ウィンドウごとに最大 1 回に制限します（デフォルト）
- 1 回の再読み込みでは解消しない、本当に停止した再生が発生している場合のみ有効にしてください

**`twitchAdSolutions_preferLowQualityBackup`**（デフォルト: `true`、vaft のみ）
- SSAI が多い広告向けのハイブリッドな安全策です。すべての Source タイプ（site / popout / mobile_web / embed）に広告が含まれる場合の最終手段として `autoplay`（360p）をバックアップに追加します。また、`twitchAdSolutions_backupSwapFirst=false` のときにスティッキーな脱出手段（約 8 秒停止でバックアップ探索へ移行）を有効にします。
- `false` に設定すると autoplay へのフォールバックと脱出手段を無効化します
- ⚠ **画質に関する注意**: autoplay が採用されるのはすべての Source バックアップにも広告が含まれる場合のみで、まれではありますが、SSAI が多いチャンネルでの長時間のフリーズを避けるための代償として 360p になります

**`twitchAdSolutions_autoPlayOnPause`**（デフォルト: `true`、vaft のみ、本リポジトリ独自）
- プレイヤーが一時停止状態になったら自動で再生を再開します。Twitch 側の再生ボタン（`data-a-player-state="paused"`）を監視するため、動画の要素がまだ存在しないページの読み込み中でも復帰できます。
- ユーザー自身が一時停止した場合は尊重されるため、手動で止めたものが勝手に再生されることはありません。また、広告の処理中・再読み込みの直後・バックアップへの切り替え中は、広告ブロック側の復帰処理に任せて介入しません。
- `false` に設定すると無効化されます。

**`twitchAdSolutions_backupSwapFirst`**（デフォルト: `true`、vaft のみ）
- **デフォルトの広告ブロック経路**です（v63.0.0 以降）。広告を検出すると、すぐにバックアップのプレイヤータイプの m3u8 に切り替えます（site → popout → mobile_web → embed の順で、最初にクリーンだったものを採用）。従来の strip + BLANK_MP4 + リカバリ経路で発生する MediaSource の混在を回避し、ローディング表示が減り、音ズレの蓄積もなくなります。
- `false` に設定すると、従来のスティッキーな CSAI ストリップ優先の経路に戻ります。バックアップの取得が不安定なチャンネル / ネットワークで、ネイティブのストリップの方が望ましい場合に使用してください。
- ⚠ **帯域に関するトレードオフ**: 広告のたびに追加のトークン取得が発生します（セッション内で初回は約 400ms、`BackupEncodingsM3U8Cache` が温まった後はさらに短くなります）。

```js
// 広告後の切り替えを高速化
localStorage.setItem('twitchAdSolutions_reloadPlayerAfterAd', 'false');

// プレイヤータイプを変更
localStorage.setItem('twitchAdSolutions_playerType', 'embed');

// 広告ブロックのバナー（「広告をブロック中」）を非表示
localStorage.setItem('twitchAdSolutions_hideAdOverlay', 'true');

// デフォルトに戻す
localStorage.removeItem('twitchAdSolutions_reloadPlayerAfterAd');
localStorage.removeItem('twitchAdSolutions_playerType');
localStorage.removeItem('twitchAdSolutions_hideAdOverlay');
localStorage.removeItem('twitchAdSolutions_pinBackupPlayerType');
localStorage.removeItem('twitchAdSolutions_reloadCooldownSeconds');
localStorage.removeItem('twitchAdSolutions_disableReloadCap');
localStorage.removeItem('twitchAdSolutions_preferLowQualityBackup');
localStorage.removeItem('twitchAdSolutions_backupSwapFirst');
localStorage.removeItem('twitchAdSolutions_autoPlayOnPause');
```

## 既知の拡張機能との競合

- **7TV** — 黒画面 / 無限バッファリングが発生する場合があります（[#17](https://github.com/ryanbr/TwitchAdSolutions/issues/17)）
- **TwitchNoSub** — workerStringReinsert により自動的に処理されますが、古いバージョンでは競合する可能性があります
- **TTV-AB** — 同時に実行すると広告ブロックが二重に行われ、エラーの原因になります。どちらか一方を使用してください。
- **Purple AdBlock** — 両方が有効だと競合する可能性があります。どちらかを無効にしてください。
- **AdGuard Extra** — 異なるレイヤーで動作するため、併用しても競合しません

## Original fork
[pixeltris/TwitchAdSolutions](https://github.com/pixeltris/TwitchAdSolutions)