*English / [日本語](comparison.ja.md)*

# Feature Comparison

Comparison of ryanbr/TwitchAdSolutions (release & testing) vs GosuDRM/TTV-AB 6.0.7 vs pixeltris/TwitchAdSolutions (archived).

## Ad Detection

| Feature | Release | Testing | TTV-AB | pixeltris |
|---|---|---|---|---|
| Multiple ad signifiers | Yes (4) | Yes (4) | No (1 + URL patterns) | No (1) |
| Unknown-signifier diagnostic | Yes | Yes | No | No |
| SCTE-35 CUE-OUT/CUE-IN | Yes | Yes | Yes | No |
| Ad segment URL patterns | Yes | Yes | Yes | No |

## Backup Stream

| Feature | Release | Testing | TTV-AB | pixeltris |
|---|---|---|---|---|
| Backup-swap-first on ad detect (TTV-AB-style) | Yes (default, opt-out) | Yes (default, opt-out) | Yes (always on) | No |
| Backup player type cycling | Yes | Yes | Yes | Yes |
| Failed backup type tracking | Yes | Yes | Yes | No |
| Pinned backup type | Yes (default on) | Yes (default on) | Yes (always on) | No |
| Auto-pin source quality | Yes | Yes | No | No |
| Segment recovery cache | Yes | Yes | Yes | No |
| Embed player type reliability | Skipped as first-try (GQL "server error") | Skipped as first-try | Works (extension privileges) | Works |

## Ad Recovery

| Feature | Release | Testing | TTV-AB | pixeltris |
|---|---|---|---|---|
| Ad-end grace period | Yes | Yes | Yes | No |
| Dead backup detection | Yes | Yes | No | No |
| Post-ad resume retry | Yes | Yes | Yes | No |
| Muted state restore | Yes | Yes | Yes | No |
| Respect user mute intent | Yes | Yes | No | No |
| Post-hard-reload seek-to-live (drift >5s) | Yes | Yes | No | No |
| Player error auto-recovery | No | Yes | Yes | No |

## Player Stability

| Feature | Release | Testing | TTV-AB | pixeltris |
|---|---|---|---|---|
| Visibility/hidden override | Yes | Yes | Yes | Yes |
| hasFocus override | Yes | Yes | No | No |
| Tab focus auto-play | Yes | Yes | Yes | Muted only |
| Auto-resume on tab return | Yes (muted+unmuted) | Yes (muted+unmuted) | Yes | Muted only |
| Buffering monitor | Yes | Yes | Yes | Yes |
| Stuck-pause auto-recovery | Yes | Yes | No | No |
| CSAI cascade reload cooldown | Yes | Yes | No | No |
| CSAI-only skip reload | Yes | Yes | No | No |
| Ad-end grace period | Yes | Yes | No | No |
| Auto-escalate cooldown | Yes | Yes | No | No |
| Backup switch grace (10s) | Yes | Yes | No | No |
| One-reload-per-recovery cap | Yes | Yes | Yes (guarded) | No |
| Reload grace period (15s) | Yes | Yes | No | No |
| Visibility-aware poll backoff | Yes (3×) | Yes (3×) | Yes | No |
| Smooth drift correction | Yes (1.1×) | Yes (1.1×) | No | No |
| Failed backup type retry (15s) | Yes | Yes | No | No |
| Quality/volume restore | Yes | Yes | Yes | Yes |
| User pause intent tracking | Yes | Yes | Yes | No |
| Fresh player lookup every tick | Yes | Yes | No | No |
| React fallback discovery | Yes | Yes | No | No |
| Seek past buffer gaps | Yes | Yes | No | No |
| Position jump drift correction | Yes | Yes | No | No |
| Stale event filtering | No | No | Yes | No |
| Worker crash recovery | Yes | Yes | Yes | No |

## Configuration

| Feature | Release | Testing | TTV-AB | pixeltris |
|---|---|---|---|---|
| ReloadPlayerAfterAd | Yes | Yes | N/A | Hardcoded |
| ForceAccessTokenPlayerType | Yes | Yes | N/A | Hardcoded |
| PinBackupPlayerType | Yes | Yes | Always on | No |
| HideAdOverlay | Yes | Yes | N/A | No |
| ReloadCooldownSeconds | Yes | Yes | N/A | No |
| DisableReloadCap | Yes | Yes | N/A | No |
| DriftCorrectionRate | Yes | Yes | N/A | No |
| PreferLowQualityBackup (hybrid safety net) | Yes | Yes | N/A | No |
| BackupSwapFirst (TTV-AB-style default) | Yes (default on) | Yes (default on) | N/A (always on) | No |
| Config logged on load | Yes | Yes | No | No |

## Debug Logging

| Feature | Release | Testing | TTV-AB | pixeltris |
|---|---|---|---|---|
| AD DEBUG breakpoints | Yes (15+) | Yes (15+) | Minimal | No |
| Worker rejection logging | Yes | Yes | No | No |
| GQL header capture log | Yes | Yes | No | No |
| Stripped segment count | Yes | Yes | No | No |

## Hardening

| Feature | Release | Testing | TTV-AB | pixeltris |
|---|---|---|---|---|
| parseAttributes null guard | Yes | Yes | No | No |
| Blob URL revoke protection | Yes | Yes | No | No |
| Worker prototype chain cleanup | Yes | Yes | No | No |
| GQL fetch timeout (15s) | Yes | Yes | No | No |
| WASM worker JS cache | Yes | Yes | No | No |
| Stream info TTL cleanup | Yes | Yes | No | No |
| Dictionary objects (no prototype) | Yes | Yes | No | No |

## Null Safety

| Feature | Release | Testing | TTV-AB | pixeltris |
|---|---|---|---|---|
| Optional chaining | Yes | Yes | Yes | No |
| GQL response validation | Yes | Yes | Yes | No |
| parseAttributes tag prefix strip | Yes | Yes | No | No |
| GQL response shape fallback (data wrap + flat) | Yes | Yes | Yes | No |
| GQL error field in diagnostic log | Yes | Yes | No | No |
| Worker-bridge Response full shape (url/ok/redirected/type) | Yes | Yes | N/A | No |

## Compatibility

| Feature | Release | Testing | TTV-AB | pixeltris |
|---|---|---|---|---|
| WebKit/iOS | Yes | Yes | N/A | Yes |
| Firefox | Yes | Yes | Yes | Yes |
| Chrome | Yes | Yes | Yes | Yes |
