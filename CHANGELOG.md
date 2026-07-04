# Changelog

すべての注目すべき変更はこのファイルに記録します。
フォーマットは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、バージョニングは [Semantic Versioning](https://semver.org/lang/ja/) に準拠します。

## [0.2.0] - 2026-07-04

### Changed

- **5時間/週次使用率のデータ源を非公式API(`/api/oauth/usage`)から statusline ブリッジへ変更。** Claude Code が statusline コマンドの stdin へ渡す公式計算値を `~/.claude/statusline-state.json` 経由で受け取る方式になり、レート制限(429)・認証情報の読み取り・ネットワーク通信が①②の表示から一切なくなった。値は Claude Code 本体の `/usage` と同一ソース。
- **クレジット(extra usage)表示をオプトイン化(既定OFF)。** `showCredit` を有効にした場合のみ非公式APIへの通信と `.credentials.json` の読み取りを行う。既定インストールは認証情報に一切触れず、ネットワーク通信も行わない。
- ツールチップ・詳細表示から「週次(Opus)」行を削除(statusline JSON に含まれないため。非公式API経由でも実在を一度も確認できていなかった項目)。

### Added

- コマンド「Claude Usage: Set Up Statusline Bridge」: 受信状態の診断と、同意ベースのブリッジ自動設置(statusline 未設定の場合)または手動追記手順の提示(既存 statusline がある場合)。
- コンテキスト使用率のオプトイン表示(`showContextPercentage`。v0.1 では予約のみだった設定項目を実装)。
- `statuslineStatePathOverride` / `statuslineStaleMinutes` 設定。
- state ファイルの fs.watch 監視により、ポーリング間隔を待たず公式値を即時反映。

### Known limitations

- 公式値(5h/週次)は Claude Code の稼働中のみ更新されます。非稼働中は最終受信時点の値を経過時間つきで表示し続けます。
- クレジット表示(オプトイン)が使う `/api/oauth/usage` は非公式APIのままで、開発時の実測では一貫して429でした。有効化しても取得できない場合があります。
- 動作確認はWindows環境のみです。macOS/Linuxのパス解決ロジックは実装していますが未検証です。

## [0.1.0] - 2026-07-04

### Added

- ステータスバーに Claude Code の使用状況を表示する初回リリース。
- ローカルの `~/.claude/projects/**/*.jsonl` ログから推定コスト・トークン数を集計する独立層(認証情報・ネットワークに一切依存せず単独で動作)。
- `/api/oauth/usage`(非公式API)から5時間ウィンドウ・週次(全体/Opus)使用率・クレジット(extra usage)を取得する連携(取得できない場合は理由付きで劣化表示)。
- ホバーツールチップでの内訳表示、クリックでのQuickPick詳細表示(今すぐ更新・設定を開くのショートカット付き)。
- しきい値(既定70%/90%)による警告・危険表示の色分け。
- 設定項目一式(ポーリング間隔、表示項目のON/OFF、しきい値、ステータスバー位置、認証情報パスの上書き)。

### Known limitations

- `/api/oauth/usage` は非公式APIであり、Anthropicの一次ドキュメントが存在しません。将来的に予告なく変更・廃止される可能性があります。
- このAPIは頻繁にレート制限(429)が発生することを実機で確認しています。取得できない間はローカルログからの推定コスト表示のみになります。
- 動作確認はWindows環境のみです。macOS/Linuxのパス解決ロジックは実装していますが未検証です。
