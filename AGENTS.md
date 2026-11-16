# Development workflow

- Develop application features on `dev`. Merge into `main` only when requested.
- GitHub Actions are paused to conserve the monthly allowance. Keep workflows manual-only; do not enable, dispatch, or rerun them unless the user explicitly asks to resume Actions.
- Include `[skip ci]` in commits while Actions are paused, and verify that pushes do not start workflow runs.
- Run appropriate checks locally.

# エージェントへの指示

- 利用者への返答・報告・質問は、必ず日本語で書く。英語の資料を読んだあとや、作業の途中経過でも英語に切り替えない。
- コミットの作成者は利用者本人だけにする。`Co-Authored-By: Claude …` などエージェントを共著者として示す行は、コミットメッセージにも PR の本文にも入れない。過去のコミットに残っていたら、push する前にメッセージだけ書き換えて取り除く。
