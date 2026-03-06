// ========================================================
// editor.rs — Markdownパース処理モジュール
// pulldown-cmark を使って Markdown → HTML に変換する
// ========================================================
use pulldown_cmark::{html, Options, Parser};

/// Markdown テキストを HTML 文字列へ変換する Tauri コマンド
/// フロントエンドから invoke('parse_markdown', { text }) で呼び出す
#[tauri::command]
pub fn parse_markdown(text: String) -> String {
    // パーサーオプションを設定
    // テーブル・脚注・打消し・タスクリストを有効化
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);

    // Markdown をパースしてイベントストリームを生成
    let parser = Parser::new_ext(&text, options);

    // HTML バッファへ書き出す
    let mut html_output = String::new();
    html::push_html(&mut html_output, parser);

    html_output
}
