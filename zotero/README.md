# ZoteroでPDFを対訳表示する（Linux開発版）

Zotero 10 のPDFリーダーに「訳」ボタンを追加します。左は元のリーダー、右は同じページの翻訳プレビューです。翻訳が済んだページから読めます。訳文は画像表示のため、右側で文字の選択・注釈はできません。元の添付PDFは変更しません。

1. このリポジトリのデスクトップ版と同じ [BabelDOC環境](../README.md)、ローカルのPLaMo 2Bモデル、llama-serverを準備します。
2. リポジトリ直下で `~/.local/share/anywhere-plamo-babeldoc/bin/python -I zotero/bridge.py` を実行します。このターミナルを開いたままにします。サービスは `127.0.0.1:17843` のみで待ち受けます。終了は Ctrl-C です。
3. `python3 zotero/build.py` で生成した `zotero/dist/anywhere-plamo-zotero.xpi` を、Zoteroのプラグイン管理画面から「ファイルからプラグインをインストール」で選びます。
4. PDFを開いてツールバーの「訳」を押し、「トークン設定」に `~/.config/anywhere-plamo-zotero/token` の中身を入力します。このファイルはサービス初回起動時に生成されます。トークンはチャットやIssueに貼らないでください。

翻訳サービスはデスクトップアプリとは独立しています。アプリの起動は不要です。訳文は一時プレビューで、Zoteroの添付ファイルとしては保存しません。
