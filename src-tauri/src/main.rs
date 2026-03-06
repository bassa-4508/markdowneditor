// ========================================================
// main.rs — Tauriアプリのエントリポイント
// 全モジュールからコマンドを収集して Tauri に登録する
// ========================================================

// サブモジュールを宣言
mod editor;
mod file_io;
mod watcher;

// 必要な型をインポート
use tauri::Manager;

fn main() {
    // tokio ランタイムを初期化（非同期処理のため）
    // Tauri の非同期コマンドは tokio を使う
    tauri::Builder::default()
        // 全 Rust コマンドを登録
        // フロントエンドから invoke() で呼び出せるようになる
        .invoke_handler(tauri::generate_handler![
            // Markdownパース
            editor::parse_markdown,
            // ファイルI/O
            file_io::read_file,
            file_io::save_file,
            file_io::read_dir,
            file_io::create_file,
            // ファイル監視
            watcher::start_watch,
            watcher::stop_watch,
        ])
        // アプリの初期化処理
        .setup(|app| {
            // 開発環境の場合はデベロッパーツールを有効化
            #[cfg(debug_assertions)]
            {
                let window = app.get_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        // Tauri コンテキストを生成して実行
        .run(tauri::generate_context!())
        .expect("Tauriアプリの起動中にエラーが発生しました");
}
