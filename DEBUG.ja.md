*[English](DEBUG.md) / 日本語*

# TwitchAdSolutions のデバッグ

## ブラウザのコンソールを開く

### Chrome / Edge
1. `F12` または `Ctrl+Shift+J`（Windows / Linux） / `Cmd+Option+J`（Mac）を押します
2. **Console** タブをクリックします
3. 表示を `Default` から `INFO` のみに変更すると、本スクリプトの Twitch 関連ログだけが表示されます。
4. これらのデバッグ行を 20 行以上コピーし、GitHub の報告に貼り付けてください。情報は多いほど助かります。

### Firefox
1. `F12` または `Ctrl+Shift+K`（Windows / Linux） / `Cmd+Option+K`（Mac）を押します
2. **Console** タブをクリックします
3. 表示を `INFO` のみに変更すると、本スクリプトの Twitch 関連ログだけが表示されます。
4. これらのデバッグ行を 20 行以上コピーし、GitHub の報告に貼り付けてください。情報は多いほど助かります。

### Safari
1. 開発者ツールを有効にします: 設定 > 詳細 > 「Web デベロッパ用の機能を表示」
2. `Cmd+Option+C` を押します
3. **Console** タブをクリックします
4. これらのデバッグ行を 20 行以上コピーし、GitHub の報告に貼り付けてください。情報は多いほど助かります。

## 確認すべき内容

### 起動時（ページを読み込むたびに表示されるはずです）

```
[AD DEBUG] TwitchAdSolutions vaft v68.5.1 を読み込んでいます
[AD DEBUG] 設定: ReloadPlayerAfterAd = true, ForceAccessTokenPlayerType = popout, PinBackupPlayerType = true
[AD DEBUG] window の fetch フックを設定しました
[AD DEBUG] GQL のヘッダーを取得 — DeviceId: あり、Auth: あり、Integrity: なし
[AD DEBUG] ワーカーを横取りしました — 広告ブロックのフックを注入します
[AD DEBUG] 新しいストリームセッション — チャンネル: <channel>、API: v2
```

`vaft v<番号> を読み込んでいます` が表示されない場合、スクリプトが動作していません。ユーザースクリプトマネージャー、または uBO のリソース上書き設定を確認してください。

### 通常の広告（CSAI のみ。最も一般的なケース）

```
[AD DEBUG] 広告を検出 — 種別: midroll、チャンネル: <channel>、ポッド: 1 本（想定 約30秒）、シグニファイア: stitched, stitched-ad, X-TV-TWITCH-AD
[AD DEBUG] ミッドロール広告をブロック中（embed）— バックアップを 137ms で取得（ウォームキャッシュ）
[AD DEBUG] 広告のブロックが完了 — 広告セグメントを 0 個除去、所要時間: 31 秒
[AD DEBUG] CSAI のみの広告（除去 0 件）— プレイヤーを操作せずバックアップを解除します
```

これが理想的なケースです。再読み込みもドリフト補正も中断も発生しません。

### 通常の広告（SSAI。セグメントを除去）

```
[AD DEBUG] 広告を検出 — 種別: midroll、チャンネル: <channel>、ポッド: 2 本（想定 約60秒）、シグニファイア: stitched, stitched-ad, X-TV-TWITCH-AD
[AD DEBUG] ミッドロール広告をブロック中（embed）— バックアップを 773ms で取得（コールドキャッシュ: トークン取得 1 回）
[AD DEBUG] 全セグメントを除去 — 復旧セグメントを 1 個復元します
[AD DEBUG] 広告のブロックが完了 — 広告セグメントを 16 個除去、所要時間: 62 秒
[AD DEBUG] Twitch のプレイヤーを再読み込みします（ハード）
[AD DEBUG] 再読み込み後のライブとのずれの補正: 2.9 秒遅れ
[AD DEBUG] ドリフト補正: 1.1 倍速で追いつきます
[AD DEBUG] ドリフト補正が完了 — 通常の再生速度に戻しました
```

実際の広告セグメントが除去されました。広告終了後にプレイヤーが再読み込みされ、ライブに追いつきます。

### CSAI 高速経路（バックアップへの切り替えなし）

```
[AD DEBUG] 広告を検出 — 種別: midroll、チャンネル: <channel>、ポッド: 1 本（想定 約30秒）、シグニファイア: stitched, stitched-ad, X-TV-TWITCH-AD
[AD DEBUG] CSAI 高速経路 — 全セグメントがライブのため、バックアップ探索を省略します
[AD DEBUG] 広告のブロックが完了 — 広告セグメントを 0 個除去、所要時間: 30 秒
[AD DEBUG] CSAI のみの広告（除去 0 件）— プレイヤーを操作せずバックアップを解除します
```

最良のケースです。バックアップストリームへの切り替えも再バッファリングの空白もありません。メインのストリームが途切れずに再生されます。

## よくある問題

### スクリプトが読み込まれない

| コンソールのメッセージ | 意味 |
|---|---|
| `[AD DEBUG]` のメッセージが一切出ない | スクリプトが注入されていません。ユーザースクリプトマネージャーが twitch.tv で有効になっているか確認してください |
| `ワーカー JS の取得に失敗 — 未改変のワーカーにフォールバックします` | 同期 XHR がブロックされています（iOS Safari）。ストリームは再生されますが広告はブロックされません |
| `競合: vaft v<X> をスキップしました — 別のスクリプトがすでに有効です（v<Y>）` | スクリプトが重複してインストールされています。どちらかを削除してください |

### 広告が漏れて表示される

| コンソールのメッセージ | 意味 |
|---|---|
| `広告のないバックアップストリームが見つかりません` | すべてのバックアップのプレイヤータイプにも広告が含まれています。広告が短時間表示されることがあります |
| `解像度の情報が取得できないため広告が漏れます` | ストリームの解像度情報が見つかりません。まれなケースです |
| `シグニファイア:`（その後が空） | 広告検出の不一致です。最新バージョンに更新してください |

### プレイヤーの問題

| コンソールのメッセージ | 意味 |
|---|---|
| `バッファリングの修正を試みます position:X bufferedPosition:Y bufferDuration:Z` | バッファ監視が停止を検出し、一時停止 / 再生で復旧を試みています |
| `動画の状態: readyState=2 networkState=2 ... paused=true` | データ不足でプレイヤーが停止しています。自動的に回復する場合があります |
| `再生位置が X 秒飛びました — ドリフト補正を開始します` | 再生位置が飛びました。ドリフト補正が再生速度を上げてライブに追いつこうとしています |
| `PiP を維持するため、再読み込みを一時停止 / 再生に切り替えました` | PiP モードが有効です。PiP を維持するため、より軽い復旧方法を使用しています |

### Twitch API の問題

| コンソールのメッセージ | 意味 |
|---|---|
| `アクセストークンの HTTP 403（embed）（integrity: なし）` | Twitch が Client-Integrity を強制している可能性があります。この問題を報告してください |
| `アクセストークンの HTTP 403（embed）（integrity: あり）` | integrity があるにもかかわらず Twitch がトークンを拒否しました。報告してください |
| `Usher の HTTP 403（embed）` | Twitch がストリーム URL のリクエストを拒否しました |
| `GQL のレスポンスに streamPlaybackAccessToken がありません` | Twitch が API を変更しました。スクリプトの更新が必要です |
| `FetchRequest timed out` | GQL のリクエストに 15 秒以上かかりました。ネットワークの問題か Twitch の障害です（Twitch 側が出力するメッセージのため英語のままです） |

## バグの報告

問題を報告する際は、以下を含めてください:

1. **スクリプトのバージョン** — コンソール最初の行にある `TwitchAdSolutions vaft v<番号> を読み込んでいます`
2. **ブラウザとインストール方法** — 例: Chrome + Tampermonkey、Firefox + uBO
3. **コンソールのログ** — `[AD DEBUG]` の出力全体をコピーしてください。長い場合は [logpasta.com](https://logpasta.com) などのペーストサービスを利用してください
4. **発生した現象** — 見えた内容を記述してください（ローディング表示、動画の停止、広告の表示など）
5. **チャンネル** — 視聴していた Twitch のチャンネル

## localStorage による設定

ブラウザのコンソールから設定を変更できます:

```js
// 広告後の再読み込みを無効化（代わりに一時停止 / 再生を使用）
localStorage.setItem('twitchAdSolutions_reloadPlayerAfterAd', 'false');

// 再読み込みのクールダウンを変更（秒。デフォルトは 30）
localStorage.setItem('twitchAdSolutions_reloadCooldownSeconds', '60');

// ドリフト補正を無効化
localStorage.setItem('twitchAdSolutions_driftCorrectionRate', '0');

// 再読み込み回数の上限を無効化（無制限に再読み込みを許可）
localStorage.setItem('twitchAdSolutions_disableReloadCap', 'true');

// 「広告をブロック中」バナーを非表示
localStorage.setItem('twitchAdSolutions_hideAdOverlay', 'true');
```

設定を変更したらページを再読み込みしてください。
