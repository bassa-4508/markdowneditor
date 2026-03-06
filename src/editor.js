// ========================================================
// editor.js — CodeMirror 6 エディタの設定
// Markdown構文ハイライト・キーバインド・テーマを設定する
// ========================================================
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, highlightActiveLine, lineNumbers, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { searchKeymap } from "@codemirror/search";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";

/**
 * CodeMirror 6 エディタを指定のDOM要素にマウントする
 * @param {HTMLElement} parent - エディタをマウントする親要素
 * @param {Function} onChange - テキスト変更コールバック (text: string) => void
 * @returns {{ view: EditorView, setText: (s:string)=>void, getText: ()=>string }}
 */
export function createEditor(parent, onChange) {
    // 最初の起動メッセージ（ウェルカムテキスト）
    const welcomeText = [
        "# Markdowneditor へようこそ",
        "",
        "左のサイドバーからフォルダを開くか、ツールバーの「開く」でファイルを選択してください。",
        "",
        "## 使い方",
        "",
        "- **Ctrl+S** — 保存",
        "- **Ctrl+O** — ファイルを開く",
        "- **Ctrl+Shift+P** — プレビューの表示/非表示",
        "- **Ctrl+Z / Ctrl+Y** — アンドゥ / リドゥ",
        "",
        "## Markdownサンプル",
        "",
        "### コードブロック",
        "",
        "```rust",
        "fn main() {",
        '    println!("Hello, Rust!");',
        "}",
        "```",
        "",
        "### テーブル",
        "",
        "| 言語 | 速度 | 特徴 |",
        "| --- | --- | --- |",
        "| Rust | ⚡ 最速 | メモリ安全 |",
        "| Go  | 🚀 高速 | シンプル |",
        "",
        "> **TIP:** 右パネルにリアルタイムプレビューが表示されます。",
    ].join("\n");

    // エディタの状態を設定
    const startState = EditorState.create({
        doc: welcomeText,
        extensions: [
            // One Dark テーマ（VSCodeライク）
            oneDark,

            // 行番号の表示
            lineNumbers(),

            // アクティブ行のハイライト
            highlightActiveLine(),
            highlightActiveLineGutter(),

            // 選択範囲の描画
            drawSelection(),

            // Undo/Redo 履歴
            history(),

            // Markdown 言語パック（コードブロック内部も言語別にハイライト）
            markdown({
                base: markdownLanguage,
                codeLanguages: languages, // 100種類以上の言語に対応
            }),

            // シンタックスハイライト
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

            // キーバインド設定
            keymap.of([
                ...defaultKeymap,     // 標準的な編集キー
                ...historyKeymap,     // Ctrl+Z / Ctrl+Y
                ...searchKeymap,      // Ctrl+F で検索
                ...completionKeymap,  // TABで補完
                indentWithTab,        // TABでインデント
            ]),

            // オートコンプリート（見出し・リストのアイテム補完など）
            autocompletion(),

            // テキスト変更イベント
            EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                    // 変更されたときだけコールバックを呼ぶ（無駄な呼び出しを避ける）
                    onChange(update.state.doc.toString());
                }
            }),

            // エディタの基本スタイル設定
            EditorView.theme({
                "&": {
                    height: "100%",
                    fontSize: "14px",
                },
                ".cm-content": {
                    padding: "16px 0",
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    caretColor: "#89b4fa",
                },
                ".cm-line": {
                    padding: "0 20px",
                },
                ".cm-scroller": {
                    fontFamily: "inherit",
                },
            }),
        ],
    });

    // エディタビューを作成してDOMにマウント
    const view = new EditorView({
        state: startState,
        parent,
    });

    // 外部からテキストを設定する（ファイルを開いたときなど）
    function setText(text) {
        view.dispatch({
            changes: {
                from: 0,
                to: view.state.doc.length,
                insert: text,
            },
            // カーソルを先頭に戻す
            selection: { anchor: 0 },
        });
    }

    // 現在のテキストを取得する（保存時など）
    function getText() {
        return view.state.doc.toString();
    }

    // エディタにフォーカスを当てる
    function focus() {
        view.focus();
    }

    return { view, setText, getText, focus };
}
