// ========================================================
// watcher.rs — ファイル変更監視モジュール
// notify クレートを使って外部でのファイル変更を検知し、
// Tauri イベント経由でフロントエンドに通知する
// ========================================================
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{command, AppHandle, Manager};

// 現在アクティブなウォッチャーを格納する（グローバル状態）
static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

/// 指定パスの監視を開始する Tauri コマンド
/// ファイルが変更されると "file-changed" イベントをフロントエンドへ送信する
/// フロントエンドから invoke('start_watch', { path }) で呼び出す
#[command]
pub fn start_watch(app: AppHandle, path: String) -> Result<(), String> {
    // 既存のウォッチャーを破棄（前の監視を停止）
    {
        let mut guard = WATCHER.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    let app_handle = app.clone();
    let watch_path = path.clone();

    // イベントハンドラを作成
    // 変更イベントが来たらTauriイベントとしてフロントエンドへ送る
    let watcher = RecommendedWatcher::new(
        move |result: notify::Result<Event>| {
            if let Ok(event) = result {
                // 変更・作成・削除イベントのみを対象にする
                let is_relevant = matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                );

                if is_relevant {
                    // 変更されたファイルのパスを収集
                    let changed_paths: Vec<String> = event
                        .paths
                        .iter()
                        .map(|p| p.to_string_lossy().to_string())
                        .collect();

                    // フロントエンドへ "file-changed" イベントを送信
                    let _ = app_handle.emit_all("file-changed", &changed_paths);
                }
            }
        },
        // デバウンス: 10ms 以内の連続イベントをまとめる
        Config::default().with_poll_interval(Duration::from_millis(10)),
    )
    .map_err(|e| format!("ウォッチャーの作成に失敗しました: {}", e))?;

    // 監視を開始（サブディレクトリも含めて再帰的に監視）
    let mut w = watcher;
    w.watch(
        std::path::Path::new(&watch_path),
        RecursiveMode::Recursive,
    )
    .map_err(|e| format!("監視の開始に失敗しました: {}", e))?;

    // ウォッチャーをグローバル状態に保存（ドロップして終了しないようにする）
    {
        let mut guard = WATCHER.lock().map_err(|e| e.to_string())?;
        *guard = Some(w);
    }

    Ok(())
}

/// 現在の監視を停止する Tauri コマンド
/// フロントエンドから invoke('stop_watch') で呼び出す
#[command]
pub fn stop_watch() -> Result<(), String> {
    let mut guard = WATCHER.lock().map_err(|e| e.to_string())?;
    *guard = None; // ウォッチャーをドロップして監視停止
    Ok(())
}
