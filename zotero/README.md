# ZoteroでPDFを対訳表示する（Linux開発版）

Zotero 10のPDFリーダーで「訳」を押すと、左に原文、右に同じページの翻訳プレビューが表示されます。翻訳が済んだページから読めます。訳文は画像表示なので、文字の選択・注釈は原文側で行います。翻訳は一時プレビューで、ライブラリや原本は変更しません。

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
