//! `plm`: PLaMo translation from the command line. It shares the Anywhere Plamo
//! app's models, dictionary and GPU detection, so both see the same setup.

use anyplm_core::{dictionary, engine, model, protocol, ProgressEvent};
use std::{
    io::{IsTerminal, Read, Write},
    path::PathBuf,
    process::ExitCode,
};
use tokio_util::sync::CancellationToken;

const USAGE: &str = "使い方:
  plm translate [文章…] [--to 言語] [--no-dict] [--server パス]
      文章を省くと標準入力から読む。--to を省くと、日本語は英語へ、英語は日本語へ訳す。
      言語: ja, en, ko, zh-hans, fr, de, es
      --no-dict  アプリの辞書を使わない
      --server   llama-server の場所（既定では環境変数 ANYWHERE_PLAMO_LLAMA_SERVER、plm と同じフォルダの順に探す）
  plm models                 モデルの一覧（* は選択中、✓ はダウンロード済み）
  plm models use <ID>        使うモデルを選ぶ（アプリと共通の設定）
  plm models download [ID]   モデルをダウンロードする（ID を省くと選択中のモデル）";

enum Error {
    Usage(String),
    Failed(String),
    Cancelled,
}

fn usage(message: impl Into<String>) -> Error {
    Error::Usage(message.into())
}

fn failed(message: impl Into<String>) -> Error {
    Error::Failed(message.into())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("plm: 実行環境を準備できません: {error}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(&args)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(Error::Usage(message)) => {
            eprintln!("plm: {message}\n\n{USAGE}");
            ExitCode::from(2)
        }
        Err(Error::Failed(message)) => {
            eprintln!("plm: {message}");
            ExitCode::FAILURE
        }
        Err(Error::Cancelled) => {
            eprintln!("plm: 中断しました。");
            ExitCode::from(130)
        }
    }
}

async fn run(args: &[String]) -> Result<(), Error> {
    match args.first().map(String::as_str) {
        Some("translate") => translate(&args[1..]).await,
        Some("models") => models(&args[1..]).await,
        Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            Ok(())
        }
        Some(other) => Err(usage(format!("不明なコマンド: {other}"))),
        None => Err(usage("コマンドを指定してください。")),
    }
}

/// The app's Tauri app_data_dir, so models, the dictionary and GPU detection are shared.
fn data_dir() -> Result<PathBuf, Error> {
    dirs::data_dir()
        .map(|directory| directory.join("app.anywhere-plamo.desktop"))
        .ok_or_else(|| failed("データの保存先が見つかりません。"))
}

fn server(flag: Option<&str>) -> Result<PathBuf, Error> {
    if let Some(path) = flag {
        let path = PathBuf::from(path);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(failed(format!(
                "llama-server が見つかりません: {}",
                path.display()
            )))
        };
    }
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from));
    std::env::var_os("ANYWHERE_PLAMO_LLAMA_SERVER")
        .map(PathBuf::from)
        .into_iter()
        .chain(beside.iter().flat_map(|directory| {
            [
                directory.join(engine::EXECUTABLE),
                directory.join("resources/runtime").join(engine::EXECUTABLE),
            ]
        }))
        // Development builds use the runtime built for the app.
        .chain(cfg!(debug_assertions).then(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../src-tauri/resources/runtime")
                .join(engine::EXECUTABLE)
        }))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            failed("llama-server が見つかりません。--server か ANYWHERE_PLAMO_LLAMA_SERVER で場所を指定してください。")
        })
}

fn cancel_on_ctrl_c() -> CancellationToken {
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    // Cancelling lets the engine drop and stop llama-server instead of leaving it running.
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            token.cancel();
        }
    });
    cancel
}

fn cancelled_or(error: String) -> Error {
    if error == "CANCELLED" {
        Error::Cancelled
    } else {
        Error::Failed(error)
    }
}

async fn translate(args: &[String]) -> Result<(), Error> {
    let (mut words, mut target, mut server_flag, mut use_dictionary) =
        (Vec::new(), None, None, true);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--to" => {
                target = Some(
                    args.next()
                        .ok_or_else(|| usage("--to のあとに言語を指定してください。"))?
                        .clone(),
                )
            }
            "--server" => {
                server_flag = Some(
                    args.next()
                        .ok_or_else(|| usage("--server のあとに場所を指定してください。"))?
                        .clone(),
                )
            }
            "--no-dict" => use_dictionary = false,
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            "-" => {}
            option if option.starts_with("--") => {
                return Err(usage(format!("不明なオプション: {option}")))
            }
            word => words.push(word.to_owned()),
        }
    }
    let text = if words.is_empty() {
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .map_err(|error| failed(format!("標準入力を読めません: {error}")))?;
        text
    } else {
        words.join(" ")
    };
    let target = match target {
        Some(target) => target,
        None => protocol::auto_target(&text)
            .ok_or_else(|| usage("翻訳先を判定できません。--to で指定してください。"))?
            .to_owned(),
    };
    let directory = data_dir()?;
    let models = directory.join("models");
    if !model::ready(&models) {
        return Err(failed(
            "翻訳モデルがありません。plm models download で取得してください。",
        ));
    }
    let glossary = if use_dictionary {
        dictionary::glossary(&text, &dictionary::load(&directory.join("dictionary.json")))
    } else {
        Vec::new()
    };
    // Reject bad input before waiting for the model to load.
    protocol::prompt_with_glossary(&text, &target, &glossary).map_err(failed)?;
    let binary = server(server_flag.as_deref())?;
    let cancel = cancel_on_ctrl_c();
    let mut engine = if server_flag.is_some() {
        engine::Engine::start(&binary, &model::path(&models), &cancel).await
    } else {
        engine::start_best(
            &binary,
            &model::path(&models),
            &directory.join("gpu-runtime"),
            &cancel,
        )
        .await
    }
    .map_err(cancelled_or)?;
    let ends_with_newline = std::sync::atomic::AtomicBool::new(false);
    let print = |event| {
        if let ProgressEvent::Token { text } = event {
            ends_with_newline.store(text.ends_with('\n'), std::sync::atomic::Ordering::Relaxed);
            let mut out = std::io::stdout().lock();
            out.write_all(text.as_bytes())
                .and_then(|_| out.flush())
                .map_err(drop)?;
        }
        Ok(())
    };
    let result = engine
        .translate(&text, &target, &glossary, &print, &cancel)
        .await
        .map_err(cancelled_or)?;
    if !ends_with_newline.load(std::sync::atomic::Ordering::Relaxed) {
        println!();
    }
    if result.truncated {
        return Err(failed(
            "訳文が長さの上限で途中で止まりました。原文を短く分けてください。",
        ));
    }
    Ok(())
}

async fn models(args: &[String]) -> Result<(), Error> {
    let models = data_dir()?.join("models");
    match args.first().map(String::as_str) {
        None => {
            let selected = model::selected(&models).id;
            for choice in model::choices(&models) {
                println!(
                    "{} {} {:<8} {}（{} MB）",
                    if choice.id == selected { "*" } else { " " },
                    if choice.ready { "✓" } else { " " },
                    choice.id,
                    choice.name,
                    choice.size / 1_000_000
                );
            }
            Ok(())
        }
        Some("use") => {
            let id = args
                .get(1)
                .ok_or_else(|| usage("モデルの ID を指定してください。"))?;
            model::select(&models, id).map_err(failed)
        }
        Some("download") => {
            if let Some(id) = args.get(1) {
                model::select(&models, id).map_err(failed)?;
            }
            if model::ready(&models) {
                eprintln!("{} はダウンロード済みです。", model::selected(&models).id);
                return Ok(());
            }
            let terminal = std::io::stderr().is_terminal();
            let report = move |event| {
                match event {
                    ProgressEvent::Download { received, total } if terminal => eprint!(
                        "\rダウンロード中 {:>3}%（{} / {} MB）",
                        received * 100 / total.max(1),
                        received / 1_000_000,
                        total / 1_000_000
                    ),
                    ProgressEvent::Verifying => eprintln!("\nファイルを確認中…"),
                    _ => {}
                }
                Ok(())
            };
            model::download(&models, &report, &cancel_on_ctrl_c())
                .await
                .map_err(cancelled_or)?;
            eprintln!("{} をダウンロードしました。", model::selected(&models).id);
            Ok(())
        }
        Some(other) => Err(usage(format!("不明な models のコマンド: {other}"))),
    }
}
