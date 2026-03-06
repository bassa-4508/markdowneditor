// ========================================================
// file_io.rs — ファイルI/Oモジュール
// tokio を使って非同期に読み書きし、UIスレッドをブロックしない
// ========================================================
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::command;
use tokio::fs;
use tokio::io::AsyncWriteExt;

/// ファイル情報を返す構造体
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileData {
    /// ファイルの絶対パス
    pub path: String,
    /// ファイルの内容（テキスト）
    pub content: String,
    /// ファイル名のみ（表示用）
    pub name: String,
}

/// ディレクトリ内のエントリ情報
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 指定パスのファイルを非同期で読み込む
/// フロントエンドから invoke('read_file', { path }) で呼び出す
#[command]
pub async fn read_file(path: String) -> Result<FileData, String> {
    // 非同期でファイルを読み込む（UIをブロックしない）
    let content = fs::read_to_string(&path)
        .await
        .map_err(|e| format!("ファイルの読み込みに失敗しました: {}", e))?;

    // ファイル名を取得
    let name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "untitled".to_string());

    Ok(FileData {
        path,
        content,
        name,
    })
}

/// 指定パスにコンテンツを非同期で書き込む
/// 一時ファイルに書いてからリネームすることで、書き込み中のクラッシュでデータを失わない
/// フロントエンドから invoke('save_file', { path, content }) で呼び出す
#[command]
pub async fn save_file(path: String, content: String) -> Result<(), String> {
    // 一時ファイルのパスを生成（元のファイルと同じディレクトリに作る）
    let tmp_path = format!("{}.tmp", path);

    // 非同期で一時ファイルに書き込む
    {
        let mut file = fs::File::create(&tmp_path)
            .await
            .map_err(|e| format!("一時ファイルの作成に失敗しました: {}", e))?;

        file.write_all(content.as_bytes())
            .await
            .map_err(|e| format!("書き込みに失敗しました: {}", e))?;

        // flush してディスクに確実に書き込む
        file.flush()
            .await
            .map_err(|e| format!("フラッシュに失敗しました: {}", e))?;
    }

    // 一時ファイルを正式なパスへアトミックにリネーム
    fs::rename(&tmp_path, &path)
        .await
        .map_err(|e| format!("ファイルの保存に失敗しました: {}", e))?;

    Ok(())
}

/// 指定ディレクトリ内のMarkdownファイル・サブディレクトリ一覧を返す
/// フロントエンドから invoke('read_dir', { path }) で呼び出す
#[command]
pub async fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = fs::read_dir(&path)
        .await
        .map_err(|e| format!("ディレクトリの読み込みに失敗しました: {}", e))?;

    let mut result: Vec<DirEntry> = Vec::new();

    // 非同期でエントリを一つずつ処理
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("エントリの読み込みに失敗しました: {}", e))?
    {
        let meta = entry
            .metadata()
            .await
            .map_err(|e| format!("メタデータの取得に失敗しました: {}", e))?;

        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = entry.path().to_string_lossy().to_string();
        let is_dir = meta.is_dir();

        // Markdownファイルまたはディレクトリのみを含める
        if is_dir || name.ends_with(".md") || name.ends_with(".markdown") {
            result.push(DirEntry {
                name,
                path: entry_path,
                is_dir,
            });
        }
    }

    // ディレクトリを先に、ファイルを後に並べる
    result.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });

    Ok(result)
}

/// 新規ファイルを作成してパスを返す
/// フロントエンドから invoke('create_file', { dir_path, name }) で呼び出す
#[command]
pub async fn create_file(dir_path: String, name: String) -> Result<String, String> {
    // .md 拡張子を自動付与
    let file_name = if name.ends_with(".md") || name.ends_with(".markdown") {
        name.clone()
    } else {
        format!("{}.md", name)
    };

    let full_path = format!("{}\\{}", dir_path.trim_end_matches('\\'), file_name);

    // 空ファイルを作成（すでに存在する場合はエラー）
    if Path::new(&full_path).exists() {
        return Err(format!("'{}' はすでに存在します", file_name));
    }

    fs::write(&full_path, "")
        .await
        .map_err(|e| format!("ファイルの作成に失敗しました: {}", e))?;

    Ok(full_path)
}
