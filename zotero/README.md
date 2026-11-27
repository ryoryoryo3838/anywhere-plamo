# ZoteroでPDFを対訳表示する（Linux開発版）

Zotero 10のPDFリーダーで「訳」を押すと、原文の隣にもう一つのZotero PDFリーダーが開きます。右側でもページは縦につながり、ツールバーで拡大・縮小できます。翻訳途中は完了したページを訳文に置き換え、残りは原文を表示します。左側をスクロールすると右側も同じページ内の位置に追従します。翻訳完了後に付けたハイライトはプラグイン専用のローカル保存で、Zoteroの原本・グループライブラリへの書き込みや端末間同期はしません。

全文翻訳が不要なら、原文の読みたい箇所をドラッグ選択してください。対訳ペインを開かなくても、標準の選択ポップアップにPLaMoの日本語訳が表示されます。

## 初回だけのセットアップ

1. [BabelDOC環境](../README.md)、ローカルのPLaMo 2Bモデル、llama-serverを準備します。
2. Linuxのユーザーサービスを有効にします。以下はチェックアウトが `~/Workspace/anywhere-plamo-babeldoc` にある場合です。別の場所に置く場合は、サービスファイルの `ExecStart` を合わせてください。
   ```sh
   cd ~/Workspace/anywhere-plamo-babeldoc
   systemctl --user enable --now "$PWD/zotero/anywhere-plamo-zotero.service"
   python3 zotero/build.py
   ```
3. Zoteroのプラグイン管理画面で「ファイルからプラグインをインストール」を選び、`zotero/dist/anywhere-plamo-zotero.xpi` を指定します。

## 普段の使い方

PDFを開いて「訳」を押すだけです。サービスはログイン時に起動し、翻訳を始めるまではモデルをロードしません。Anywhere Plamo本体やターミナルの起動は不要です。トークンはサービスが `~/.config/anywhere-plamo-zotero/token` に生成し、プラグインが自動で読み取ります。コピー・入力やZotero設定への保存は不要です。

接続できない場合は `systemctl --user status anywhere-plamo-zotero.service` で状態を確認してください。Flatpak版ではトークンファイルの読み取り権限とループバック接続が必要です。自動起動を解除するには `systemctl --user disable --now anywhere-plamo-zotero.service` を実行します。
