# Anywhere Plamo

文章・画面・カメラの文字を翻訳する非公式PLaMoクライアントです。Linux・macOSに対応し、Windows・Android版は開発中です。PLaMo 3 Translateを端末上で動かし、モデル取得後はオフラインで翻訳できます。

<table>
  <tr><th>OCRレンズ</th><th>選択した文章の翻訳</th></tr>
  <tr>
    <td width="50%"><img src="docs/images/ocr-lens.gif" alt="OCRレンズで画像内の英文を日本語に翻訳するデモ" width="100%"></td>
    <td width="50%"><img src="docs/images/selection-translation.gif" alt="Webページで選択した英文をショートカットで日本語に翻訳するデモ" width="100%"></td>
  </tr>
</table>

## アプリ本体

アプリ本体は[Releases](https://github.com/romanohu/anywhere-plamo/releases/latest)からダウンロードしてください。

## ドキュメント

[セットアップ・使い方・ビルド手順](docs/README.md)

### PDF の対訳プレビュー（デスクトップ・開発版）

テキストを含む PDF を対象に、BabelDOC がページを組み直し、本文を端末内の PLaMo で翻訳します。レイアウトは完全には再現されません。フォーム・注釈・リンクの保持や画像内の文字の翻訳には対応を保証していません。元の PDF は残してください。

初回のみ、翻訳モデルに加えて BabelDOC とレイアウト解析用アセットの取得が必要です。Linux/macOS のセットアップ例（`uv` 使用）:

```sh
uv venv --python 3.12 ~/.local/share/anywhere-plamo-babeldoc
export ANYWHERE_PLAMO_BABELDOC_PYTHON="$HOME/.local/share/anywhere-plamo-babeldoc/bin/python"
uv pip install --python "$ANYWHERE_PLAMO_BABELDOC_PYTHON" 'BabelDOC==0.7.1'
env -u PYTHONPATH "$(dirname "$ANYWHERE_PLAMO_BABELDOC_PYTHON")/babeldoc" --warmup
```

この環境変数を設定した状態で開発版を起動してください。PDF を開き、翻訳先を選んで BabelDOC の翻訳を開始すると、完成したページから原文と見比べられます。最終 PDF の保存用に同じページを翻訳し直す必要はありません。
