use super::{protocol, AppState};
use std::{
    io,
    path::Path,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::ipc::{InvokeBody, Request};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

const SCRIPT: &str = include_str!("../../scripts/babeldoc_pdf.py");

struct Session {
    id: uuid::Uuid,
    dir: tempfile::TempDir,
    ready: AtomicBool,
}
#[derive(Default)]
pub struct Sessions(Mutex<Option<Arc<Session>>>);
impl Sessions {
    fn get(&self, job: &str) -> Result<Arc<Session>, String> {
        self.0
            .lock()
            .map_err(|_| "PDFを開けません。")?
            .as_ref()
            .filter(|s| s.id.to_string() == job)
            .cloned()
            .ok_or_else(|| "PDFを閉じました。".into())
    }
}

#[tauri::command]
pub async fn translate_babeldoc_pdf(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    sessions: tauri::State<'_, Sessions>,
    request: Request<'_>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("メイン画面から実行してください。".into());
    }
    let target = request
        .headers()
        .get("x-target")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !protocol::supports_target(target) {
        return Err("翻訳先の言語を選び直してください。".into());
    }
    let InvokeBody::Raw(data) = request.body() else {
        return Err("PDFを読み込めません。".into());
    };
    if data.len() > 64 * 1024 * 1024 || !data.windows(5).take(1024).any(|part| part == b"%PDF-") {
        return Err("64 MB以下のPDFを選んでください。".into());
    }
    let operation = state.begin(window.label())?;
    let id = request
        .headers()
        .get("x-job")
        .and_then(|v| v.to_str().ok())
        .ok_or("PDFの識別子がありません。")?;
    let session = Arc::new(Session {
        id: uuid::Uuid::parse_str(id).map_err(|_| "PDFの識別子が不正です。")?,
        dir: private_workspace().map_err(io_error)?,
        ready: AtomicBool::new(false),
    });
    *sessions.0.lock().map_err(|_| "PDFを開けません。")? = Some(session.clone());
    let mut engine = state.lock_engine(&operation.token).await?;
    if !engine.as_mut().is_some_and(|engine| engine.alive()) {
        state.start_engine(&mut engine, &operation.token).await?;
    }
    let (url, key) = engine
        .as_ref()
        .ok_or("翻訳エンジンが見つかりません。")?
        .endpoint();
    export(&session, data, target, url, key, &operation.token).await
}

fn private_workspace() -> io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("plamo-pdf-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder.tempdir()
}

fn io_error(error: io::Error) -> String {
    format!("翻訳PDFを保存できません: {error}")
}

async fn export(
    session: &Session,
    data: &[u8],
    target: &str,
    url: &str,
    key: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let work = &session.dir;
    let script = work.path().join("babeldoc_pdf.py");
    let input = work.path().join("input.pdf");
    tokio::fs::write(&script, SCRIPT).await.map_err(io_error)?;
    tokio::fs::write(&input, data).await.map_err(io_error)?;
    let translated = work.path().join("translated.pdf");
    let previews = work.path().join("pages");
    tokio::fs::create_dir(&previews).await.map_err(io_error)?;
    let python =
        std::env::var_os("ANYWHERE_PLAMO_BABELDOC_PYTHON").unwrap_or_else(|| "python3".into());
    let mut command = Command::new(python);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .arg("-I")
        .arg(script)
        .arg(input)
        .arg(&translated)
        .args(["--target", target, "--server-url", url])
        .env("ANYWHERE_PLAMO_API_KEY", key)
        .arg("--preview-dir")
        .arg(previews)
        .current_dir(work.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("BabelDOCのPythonを起動できません。ANYWHERE_PLAMO_BABELDOC_PYTHON を確認してください: {e}"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("BabelDOCのエラーを取得できません。")?;
    let read_errors = async move {
        let mut tail = Vec::new();
        let mut buf = [0; 4096];
        loop {
            let n = stderr.read(&mut buf).await?;
            if n == 0 {
                return Ok::<_, io::Error>(tail);
            }
            tail.extend_from_slice(&buf[..n]);
            tail.drain(..tail.len().saturating_sub(4096));
        }
    };
    let (status, stderr) = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            let _ = child.kill().await;
            return Err("CANCELLED".into());
        }
        result = async { tokio::try_join!(child.wait(), read_errors) } => result.map_err(io_error)?,
    };
    if !status.success() {
        return Err(format!(
            "BabelDOCで翻訳できません: {}",
            String::from_utf8_lossy(&stderr)
                .trim()
                .replace(key, "[redacted]")
        ));
    }
    let mut header = [0; 5];
    tokio::fs::File::open(&translated)
        .await
        .map_err(io_error)?
        .read_exact(&mut header)
        .await
        .map_err(io_error)?;
    if &header != b"%PDF-" {
        return Err("BabelDOCがPDFを出力しませんでした。".into());
    }
    session.ready.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn babeldoc_progress(
    sessions: tauri::State<'_, Sessions>,
    job: String,
    after: u32,
) -> Result<u32, String> {
    let session = sessions.get(&job)?;
    let mut count = after;
    let pages = session.dir.path().join("pages");
    while let Some(next) = count.checked_add(1) {
        if !pages.join(format!("{next}.pdf")).is_file() {
            break;
        }
        count = next;
    }
    Ok(count)
}

#[tauri::command]
pub async fn read_babeldoc_pdf(
    sessions: tauri::State<'_, Sessions>,
    job: String,
    page: u32,
) -> Result<tauri::ipc::Response, String> {
    let session = sessions.get(&job)?;
    let path = if page == 0 {
        if !session.ready.load(Ordering::Acquire) {
            return Err("翻訳中です。".into());
        }
        session.dir.path().join("translated.pdf")
    } else {
        session.dir.path().join("pages").join(format!("{page}.pdf"))
    };
    Ok(tauri::ipc::Response::new(
        tokio::fs::read(path).await.map_err(io_error)?,
    ))
}

#[tauri::command]
pub fn release_babeldoc_pdf(sessions: tauri::State<'_, Sessions>, job: String) {
    if let Ok(mut session) = sessions.0.lock() {
        if session.as_ref().is_some_and(|s| s.id.to_string() == job) {
            *session = None;
        }
    }
}

#[tauri::command]
pub async fn save_babeldoc_pdf(
    window: tauri::WebviewWindow,
    sessions: tauri::State<'_, Sessions>,
    job: String,
) -> Result<Option<String>, String> {
    let session = sessions.get(&job)?;
    if !session.ready.load(Ordering::Acquire) {
        return Err("翻訳中です。".into());
    }
    let picker = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("翻訳PDFを新しいファイルに保存")
        .add_filter("PDF", &["pdf"])
        .set_file_name("translated.pdf");
    let Some(chosen) = picker.save_file().await else {
        return Ok(None);
    };
    let output = chosen.path();
    if !output
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    {
        return Err("拡張子が .pdf の保存先を選んでください。".into());
    }
    if output.symlink_metadata().is_ok() {
        return Err("同名のファイルがあります。別の名前を選んでください。".into());
    }
    sessions.get(&job)?; // The viewer may have closed while the picker was open.
    publish(&session.dir.path().join("translated.pdf"), output).await?;
    Ok(Some(output.display().to_string()))
}

async fn publish(source: &Path, destination: &Path) -> Result<(), String> {
    let temporary =
        tempfile::NamedTempFile::new_in(destination.parent().ok_or("保存先が不明です。")?)
            .map_err(io_error)?
            .into_temp_path();
    tokio::fs::copy(source, &temporary)
        .await
        .map_err(io_error)?;
    temporary
        .persist_noclobber(destination)
        .map_err(|e| io_error(e.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn publishing_refuses_to_overwrite_even_after_selection() {
        let work = tempfile::tempdir().unwrap();
        let src = work.path().join("result.pdf");
        let dest = work.path().join("chosen.pdf");
        std::fs::write(&src, b"first").unwrap();
        super::publish(&src, &dest).await.unwrap();
        std::fs::write(&src, b"second").unwrap();
        assert!(super::publish(&src, &dest).await.is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"first");
    }
}
