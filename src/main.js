// ========================================================
// main.js — アプリケーションのメインロジック
// Tauri invoke / listen を使ってRustバックエンドと連携する
// ========================================================

// Tauri の API をインポート（Vite + Tauri v1 の標準的な方法）
import { invoke } from "@tauri-apps/api/tauri";
import { open as openDialog, save as saveDialog } from "@tauri-apps/api/dialog";
import { listen } from "@tauri-apps/api/event";
import { appWindow } from "@tauri-apps/api/window";
import { resolve } from "@tauri-apps/api/path"; // デフォルトファイルのパス解決用

// CodeMirror エディタのファクトリー関数
import { createEditor } from "./editor.js";

// Mermaid: フローチャート・シーケンス図などの図表レンダリング
import mermaid from "mermaid";

// Mermaid をダークテーマで初期化（startOnLoad:false で手動レンダリング）
mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    securityLevel: "loose",      // HTML を含むラベルを許可
    fontFamily: "JetBrains Mono, Fira Code, monospace",
    fontSize: 14,
    // ダークテーマの色をアプリのカラーパレットに合わせる
    themeVariables: {
        darkMode: true,
        background: "#1e1e2e",
        primaryColor: "#313244",
        primaryTextColor: "#cdd6f4",
        primaryBorderColor: "#45475a",
        lineColor: "#89b4fa",
        secondaryColor: "#181825",
        tertiaryColor: "#11111b",
    },
});

// ─── アプリのステート ──────────────────────────────────────────
let currentFilePath = null;  // 現在開いているファイルのパス (null = 新規)
let currentDirPath = null;  // サイドバーで開いているディレクトリ
let isUnsaved = false; // 未保存フラグ
let autoSaveTimer = null;  // 自動保存のデバウンスタイマー
let previewEnabled = true;  // プレビュー表示フラグ
let readonlyMode = false;   // 読み取り専用モードフラグ
let syncScrollLock = false; // スクロール同期の無限ループ防止フラグ
let editor = null;  // CodeMirror インスタンス

// ─── DOM参照を一括取得 ──────────────────────────────────────────
const $ = id => document.getElementById(id);

const dom = {
    appTitle: $("app-title"),
    currentFileName: $("current-file-name"),
    saveIndicator: $("save-indicator"),
    editorStats: $("editor-stats"),
    codemirrorHost: $("codemirror-host"),
    fileTree: $("file-tree"),
    fileTreeEmpty: $("file-tree-empty"),
    previewContent: $("preview-content"),
    previewPane: $("preview-pane"),

    // ツールバーボタン
    btnOpenFile: $("btn-open-file"),
    btnSave: $("btn-save"),
    btnSaveAs: $("btn-save-as"),
    btnTogglePreview: $("btn-toggle-preview"),
    btnReadonly: $("btn-readonly"),        // 読み取り専用ボタン

    // サイドバーボタン
    btnOpenDir: $("btn-open-dir"),
    btnNewFile: $("btn-new-file"),
    btnOpenFileSidebar: $("btn-open-file-sidebar"), // ファイル直接開く
    recentFilesList: $("recent-files-list"),        // 最近のファイルリスト
    recentFilesEmpty: $("recent-files-empty"),      // リストが空のときのプレースホルダー
    btnCopyHtml: $("btn-copy-html"),

    // ウィンドウボタン
    btnMinimize: $("btn-minimize"),
    btnMaximize: $("btn-maximize"),
    btnClose: $("btn-close"),

    // サイズ変更ハンドル
    sidebarResize: $("sidebar-resize"),
    paneDivider: $("pane-divider"),
    sidebar: $("sidebar"),
    editorPane: $("editor-pane"),         // 読み取り専用の切り替えに使用

    // モーダル
    modalOverlay: $("modal-overlay"),
    newFileInput: $("new-file-input"),
    modalCancel: $("modal-cancel"),
    modalConfirm: $("modal-confirm"),

    // トースト
    toastContainer: $("toast-container"),
};

// ─── トースト通知 ──────────────────────────────────────────
/**
 * 画面右下にトースト通知を表示する
 * @param {string} message - 表示するメッセージ
 * @param {'success'|'error'|'warning'|''} type - トーストの種類
 */
function showToast(message, type = "") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`.trim();
    toast.style.setProperty("--toast-duration", "3s");
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);

    // アニメーション終了後に DOM から削除
    toast.addEventListener("animationend", (e) => {
        if (e.animationName === "toast-out") toast.remove();
    });
}

// ─── 保存状態の表示 ───────────────────────────────────────
function setSaveState(state) {
    // state: 'saved' | 'unsaved' | 'saving'
    dom.saveIndicator.className = "save-indicator" + (state !== "saved" ? ` ${state}` : "");
    isUnsaved = (state === "unsaved");
}

// ─── タイトルバーのファイル名更新 ─────────────────────────
function updateTitle(fileName) {
    dom.currentFileName.textContent = fileName || "新規ドキュメント";
}

// ─── エディタの統計情報（文字数・行数）を更新 ───────────────
function updateStats(text) {
    const chars = [...text].length; // Unicode を正しくカウント
    const lines = text.split("\n").length;
    dom.editorStats.textContent = `${chars.toLocaleString()} 文字  ·  ${lines.toLocaleString()} 行`;
}

// ─── Markdownをパースしてプレビューに反映 ──────────────────
async function updatePreview(text) {
    if (!previewEnabled) return;

    // Rust の parse_markdown コマンドを呼び出す
    try {
        const html = await invoke("parse_markdown", { text });

        // XSS対策として、プレビューにはターゲット属性を付与して外部リンクを安全に開く
        dom.previewContent.innerHTML = html;

        // プレビュー内の外部リンクを新しいウィンドウで開く
        dom.previewContent.querySelectorAll("a[href^='http']").forEach(a => {
            a.target = "_blank";
            a.rel = "noopener noreferrer";
        });

        // プレースホルダーを隠す（コンテンツがある場合）
        const placeholder = dom.previewContent.querySelector(".preview-placeholder");
        if (placeholder && text.trim()) placeholder.style.display = "none";

        // ─ 見出し（h1~h6）にIDを自動付与して目次からのジャンプを可能にする
        dom.previewContent.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((heading) => {
            if (!heading.id) {
                // スペースをハイフンに置換、不要な記号を除去してID化
                const id = heading.textContent.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w\-\u3000-\u30FF\u4E00-\u9FFF\u3040-\u309F]/g, '');
                if (id) heading.id = id;
            }
        });

        // 目次などのアンカーリンククリックイベント（スムーズスクロール対応）
        dom.previewContent.querySelectorAll("a[href^='#']").forEach(a => {
            a.addEventListener("click", (e) => {
                const targetId = decodeURIComponent(a.getAttribute("href").substring(1));
                const targetElement = document.getElementById(targetId) || document.querySelector(`[id="${targetId}"]`);
                if (targetElement) {
                    e.preventDefault();
                    targetElement.scrollIntoView({ behavior: "smooth" });
                }
            });
        });

        // ─ 数式ブロックの変換（```math）
        dom.previewContent.querySelectorAll("pre > code.language-math").forEach((codeEl) => {
            const formula = codeEl.textContent.trim();
            const div = document.createElement("div");
            div.className = "math-block mathjax-render";
            div.textContent = "\\[" + formula + "\\]";
            codeEl.closest("pre").replaceWith(div);
        });

        // MathJax レンダリング
        if (window.MathJax) {
            try {
                await window.MathJax.typesetPromise([dom.previewContent]);
            } catch (mathErr) {
                console.warn("MathJaxレンダリングエラー:", mathErr);
            }
        }

        // ─ Mermaid ダイアグラムのレンダリング（```mermaid）
        // pulldown-cmark → <pre><code class="language-mermaid">...</code></pre>
        const mermaidEls = [
            ...dom.previewContent.querySelectorAll("pre > code.language-mermaid"),
        ];
        let mermaidSeq = 0;
        for (const codeEl of mermaidEls) {
            const source = codeEl.textContent.trim();
            const containerId = `mermaid-${Date.now()}-${mermaidSeq++}`;
            const wrapper = document.createElement("div");
            wrapper.className = "diagram-block mermaid-block";

            try {
                // mermaid.render(id, source) → { svg: string }
                const { svg } = await mermaid.render(containerId, source);
                wrapper.innerHTML = svg;
            } catch (mermaidErr) {
                wrapper.innerHTML = `<div class="diagram-error">
                    <span class="diagram-error-icon">⚠</span>
                    Mermaid エラー: ${String(mermaidErr).replace(/</g, "&lt;")}
                </div>`;
            }

            codeEl.closest("pre").replaceWith(wrapper);
        }

        // ─ PlantUML ダイアグラムのレンダリング（```uml）
        // plantuml.com の公開 SVG エンドポイントへ画像リクエストを送る
        const umlEls = [
            ...dom.previewContent.querySelectorAll("pre > code.language-uml"),
        ];
        for (const codeEl of umlEls) {
            const source = codeEl.textContent.trim();
            const wrapper = document.createElement("div");
            wrapper.className = "diagram-block uml-block";

            try {
                // PlantUML テキストをエンコード（deflate + 独自 base64）
                const encoded = await encodePlantUML(source);
                const img = document.createElement("img");
                img.src = `https://www.plantuml.com/plantuml/svg/${encoded}`;
                img.alt = "PlantUML Diagram";
                img.className = "diagram-img";
                img.loading = "lazy";
                // 読み込みエラー時のフォールバック
                img.addEventListener("error", () => {
                    wrapper.innerHTML = `<div class="diagram-error">
                        <span class="diagram-error-icon">⚠</span>
                        PlantUML のレンダリングに失敗しました（ネット接続を確認してください）
                    </div>`;
                });
                wrapper.appendChild(img);
            } catch (umlErr) {
                wrapper.innerHTML = `<div class="diagram-error">
                    <span class="diagram-error-icon">⚠</span>
                    PlantUML エンコードエラー: ${String(umlErr).replace(/</g, "&lt;")}
                </div>`;
            }

            codeEl.closest("pre").replaceWith(wrapper);
        }

        // 画像にリサイズハンドルを付与する
        if (typeof makeImagesResizable === "function") {
            makeImagesResizable();
        }

        // ─ Kroki API を使った汎用ダイアグラムレンダリング関数 ─
        // D2, bytefield 等に対応
        async function renderKroki(diagramEls, type) {
            for (const codeEl of diagramEls) {
                const source = codeEl.textContent.trim();
                const wrapper = document.createElement("div");
                wrapper.className = `diagram-block ${type}-block`;
                try {
                    // pako (zlib/deflate) で圧縮して base64 エンコード
                    // kroki.io の bytefield は json/yaml ではなく xml/svg, またはソースそのままを送る
                    const data = new TextEncoder().encode(source);
                    const compressed = window.pako.deflate(data, { level: 9 });
                    const result = String.fromCharCode.apply(null, compressed);
                    const encodedUrl = btoa(result).replace(/\+/g, '-').replace(/\//g, '_');

                    const img = document.createElement("img");
                    img.src = `https://kroki.io/${type}/svg/${encodedUrl}`;
                    img.alt = `${type} Diagram`;
                    img.className = "diagram-img";
                    img.loading = "lazy";
                    img.addEventListener("error", () => {
                        wrapper.innerHTML = `<div class="diagram-error"><span class="diagram-error-icon">⚠</span>${type} のレンダリングに失敗しました（ネット接続確認）</div>`;
                    });
                    wrapper.appendChild(img);
                } catch (err) {
                    wrapper.innerHTML = `<div class="diagram-error"><span class="diagram-error-icon">⚠</span>${type} エンコードエラー: ${String(err)}</div>`;
                }
                codeEl.closest("pre").replaceWith(wrapper);
            }
        }

        // ─ D2 ダイアグラム (kroki.io) ─
        await renderKroki([...dom.previewContent.querySelectorAll("pre > code.language-d2")], "d2");

        // ─ bytefield-svg (kroki.io) ─
        await renderKroki([...dom.previewContent.querySelectorAll("pre > code.language-bytefield")], "bytefield");

        // ─ WaveDrom (CDNライブラリ) ─
        if (window.WaveDrom) {
            let wdSeq = 0;
            dom.previewContent.querySelectorAll("pre > code.language-wavedrom").forEach(codeEl => {
                const source = codeEl.textContent.trim();
                const wrapper = document.createElement("div");
                wrapper.className = "diagram-block wavedrom-block";
                const tempId = `wavedrom-${Date.now()}-${wdSeq++}`;

                // textarea をダミー生成して js がパースできるよう対応
                const scriptEl = document.createElement("script");
                scriptEl.type = "WaveDrom";
                scriptEl.id = tempId;
                scriptEl.textContent = source;
                wrapper.appendChild(scriptEl);
                codeEl.closest("pre").replaceWith(wrapper);
            });
            // DOM更新完了後にWaveDromで一括レンダリング
            setTimeout(() => {
                try { window.WaveDrom.ProcessAll(); }
                catch (e) { console.warn("WaveDromレンダリングエラー", e); }
            }, 50);
        }

        // ─ Vega / Vega-Lite (CDNライブラリ) ─
        if (window.vegaEmbed) {
            let vegaSeq = 0;
            for (const codeEl of [...dom.previewContent.querySelectorAll("pre > code.language-vega"), ...dom.previewContent.querySelectorAll("pre > code.language-vega-lite")]) {
                const source = codeEl.textContent.trim();
                const isLite = codeEl.className.includes("vega-lite");
                const wrapper = document.createElement("div");
                wrapper.className = "diagram-block vega-block";
                const tempId = `vega-${Date.now()}-${vegaSeq++}`;
                wrapper.id = tempId;
                codeEl.closest("pre").replaceWith(wrapper);

                try {
                    const spec = JSON.parse(source);
                    vegaEmbed(`#${tempId}`, spec, { mode: isLite ? "vega-lite" : "vega", actions: false });
                } catch (e) {
                    wrapper.innerHTML = `<div class="diagram-error"><span class="diagram-error-icon">⚠</span>Vega JSON パースエラー: ${String(e)}</div>`;
                }
            }
        }

        // ─ Graphviz DOT (CDNライブラリ d3-graphviz) ─
        if (window.d3 && window.d3.select) {
            let gvSeq = 0;
            dom.previewContent.querySelectorAll("pre > code.language-dot, pre > code.language-graphviz").forEach(codeEl => {
                const source = codeEl.textContent.trim();
                const wrapper = document.createElement("div");
                wrapper.className = "diagram-block graphviz-block";
                const tempId = `graphviz-${Date.now()}-${gvSeq++}`;
                wrapper.id = tempId;
                codeEl.closest("pre").replaceWith(wrapper);

                // レンダリング (非同期にWASMロードされる)
                try {
                    window.d3.select(`#${tempId}`)
                        .graphviz({ useWorker: false })
                        .renderDot(source)
                        .onerror(function () {
                            wrapper.innerHTML = `<div class="diagram-error"><span class="diagram-error-icon">⚠</span>Graphvizの描画に失敗しました</div>`;
                        });
                } catch (e) {
                    wrapper.innerHTML = `<div class="diagram-error"><span class="diagram-error-icon">⚠</span>Graphviz エラー: ${String(e)}</div>`;
                }
            });
        }

        // ─ ABC Notation (楽譜 CDNライブラリ ABCJS) ─
        if (window.ABCJS) {
            let abcSeq = 0;
            dom.previewContent.querySelectorAll("pre > code.language-abc").forEach(codeEl => {
                const source = codeEl.textContent.trim();
                const wrapper = document.createElement("div");
                wrapper.className = "diagram-block abc-block";
                const tempId = `abc-${Date.now()}-${abcSeq++}`;
                wrapper.id = tempId;
                // SVG用コンテナとMIDI用コンテナを用意
                wrapper.innerHTML = `<div class="abc-visual"></div><div class="abc-audio"></div>`;
                codeEl.closest("pre").replaceWith(wrapper);

                try {
                    ABCJS.renderAbc(wrapper.querySelector(".abc-visual"), source, { responsive: "resize" });
                    // MIDIオーディオプレイヤーが必要であれば有効化
                    /* ABCJS.renderSynth(wrapper.querySelector(".abc-audio"), ...); */
                } catch (e) {
                    wrapper.innerHTML = `<div class="diagram-error"><span class="diagram-error-icon">⚠</span>ABC Notation エラー: ${String(e)}</div>`;
                }
            });
        }


    } catch (err) {
        console.error("Markdownパースエラー:", err);
    }
}

// =====================================================================
// ─── PlantUML エンコーダー ──────────────────────────────────────────
// plantuml.com の API URL に使う独自エンコードを実装
// エンコード手順: UTF-8 → deflate-raw 圧縮 → PlantUML base64
// =====================================================================

// PlantUML 独自の base64 アルファベット（標準と異なる）
const PUML_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

/** 3バイト → 4文字の変換（PlantUML用） */
function puml3bytes(b1, b2, b3) {
    return (
        PUML_ALPHABET[(b1 >> 2) & 0x3f] +
        PUML_ALPHABET[((b1 & 0x3) << 4) | ((b2 >> 4) & 0xf)] +
        PUML_ALPHABET[((b2 & 0xf) << 2) | ((b3 >> 6) & 0x3)] +
        PUML_ALPHABET[b3 & 0x3f]
    );
}

/** Uint8Array → PlantUML base64 文字列 */
function pumlBase64(data) {
    let result = "";
    const len = data.length;
    for (let i = 0; i < len; i += 3) {
        if (i + 2 < len) {
            result += puml3bytes(data[i], data[i + 1], data[i + 2]);
        } else if (i + 1 < len) {
            // 2バイト残り
            result += puml3bytes(data[i], data[i + 1], 0).slice(0, 3);
        } else {
            // 1バイト残り
            result += puml3bytes(data[i], 0, 0).slice(0, 2);
        }
    }
    return result;
}

/**
 * PlantUML ソースをエンコードして plantuml.com の URL で使える文字列を返す
 * @param {string} source - PlantUML のソーステキスト
 * @returns {Promise<string>} エンコード済み文字列
 */
async function encodePlantUML(source) {
    // @startuml / @enduml がない場合は自動付与
    const wrapped = source.startsWith("@") ? source : `@startuml\n${source}\n@enduml`;

    // UTF-8 エンコード
    const encoded = new TextEncoder().encode(wrapped);

    // deflate-raw 圧縮（Web 標準 CompressionStream API）
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    writer.write(encoded);
    writer.close();

    const chunks = [];
    const reader = cs.readable.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }

    // チャンクを結合して Uint8Array にする
    const totalLen = chunks.reduce((acc, v) => acc + v.length, 0);
    const compressed = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
        compressed.set(chunk, offset);
        offset += chunk.length;
    }

    return pumlBase64(compressed);
}

// ─── テキスト変更ハンドラ（エディタから呼ばれる） ───────────
let parseDebounceTimer = null;

function onEditorChange(text) {
    // 未保存フラグを立てる
    setSaveState("unsaved");
    updateStats(text);

    // プレビュー更新：300ms デバウンス（高頻度入力でもRustに過負荷をかけない）
    clearTimeout(parseDebounceTimer);
    parseDebounceTimer = setTimeout(() => {
        updatePreview(text);
    }, 300);

    // 自動保存：1000ms デバウンス（入力停止1秒後に保存）
    if (currentFilePath) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(() => {
            autoSave(text);
        }, 1000);
    }
}

// ─── 自動保存 ─────────────────────────────────────────────
async function autoSave(text) {
    if (!currentFilePath) return;

    setSaveState("saving");

    try {
        await invoke("save_file", { path: currentFilePath, content: text });
        setSaveState("saved");
    } catch (err) {
        setSaveState("unsaved");
        console.error("自動保存エラー:", err);
    }
}

// ─── ファイルを開く ────────────────────────────────────────
async function openFile(filePath = null) {
    try {
        // パスが指定されていない場合はダイアログを表示
        if (!filePath) {
            filePath = await openDialog({
                filters: [
                    { name: "Markdown", extensions: ["md", "markdown"] },
                ],
                title: "ファイルを開く",
            });

            if (!filePath) return; // キャンセル
        }

        // Rust からファイルを読み込む
        const fileData = await invoke("read_file", { path: filePath });

        // エディタにテキストをセット
        editor.setText(fileData.content);
        currentFilePath = fileData.path;

        // タイトル・状態を更新
        updateTitle(fileData.name);
        updateStats(fileData.content);
        setSaveState("saved");

        // 最近使ったファイルに追加
        if (typeof addRecentFile === "function") {
            addRecentFile(fileData.path, fileData.name);
        }

        // プレビューを更新
        updatePreview(fileData.content);

        // ファイルが属するディレクトリを自動で開く（サイドバーに表示）
        const dirPath = fileData.path.substring(0, fileData.path.lastIndexOf("\\"));
        if (dirPath && dirPath !== currentDirPath) {
            await loadDirectory(dirPath);
        }

        // ファイルツリーのアクティブ項目を更新
        highlightActiveFile(fileData.path);

        editor.focus();

    } catch (err) {
        if (!err?.includes("cancelled") && !err?.includes("canceled")) {
            showToast(`ファイルを開けませんでした: ${err}`, "error");
        }
    }
}

// ─── ファイルを保存 ────────────────────────────────────────
async function saveFile(forceDialog = false) {
    const text = editor.getText();

    // 保存先パスが未設定 or 「名前をつけて保存」の場合はダイアログ
    if (!currentFilePath || forceDialog) {
        const savePath = await saveDialog({
            filters: [
                { name: "Markdown", extensions: ["md", "markdown"] },
            ],
            defaultPath: "document.md",
            title: "名前をつけて保存",
        });

        if (!savePath) return; // キャンセル
        currentFilePath = savePath;

        // ファイル名をタイトルに反映
        const name = savePath.split("\\").pop();
        updateTitle(name);
    }

    setSaveState("saving");

    try {
        await invoke("save_file", { path: currentFilePath, content: text });
        setSaveState("saved");

        // 最近使ったファイルに追加
        if (typeof addRecentFile === "function") {
            const name = currentFilePath.split("\\").pop() || currentFilePath.split("/").pop();
            addRecentFile(currentFilePath, name);
        }

        showToast("保存しました ✓", "success");
    } catch (err) {
        setSaveState("unsaved");
        showToast(`保存に失敗しました: ${err}`, "error");
    }
}

// ─── ディレクトリを読み込んでサイドバーに表示 ─────────────
async function loadDirectory(dirPath) {
    currentDirPath = dirPath;

    try {
        // ファイル変更監視を開始
        await invoke("start_watch", { path: dirPath });

        // ディレクトリの内容を取得
        const entries = await invoke("read_dir", { path: dirPath });

        // ファイルツリーを再描画
        renderFileTree(entries);

    } catch (err) {
        showToast(`フォルダを開けませんでした: ${err}`, "error");
    }
}

// ─── ファイルツリーのレンダリング ─────────────────────────
function renderFileTree(entries) {
    // 既存の内容をクリア
    dom.fileTree.innerHTML = "";

    if (entries.length === 0) {
        // 空のディレクトリ
        const emptyMsg = document.createElement("div");
        emptyMsg.className = "file-tree-empty";
        emptyMsg.innerHTML = `<p style="margin:auto;padding:20px;font-size:12px;color:var(--text-muted)">Markdownファイルがありません</p>`;
        dom.fileTree.appendChild(emptyMsg);
        return;
    }

    entries.forEach(entry => {
        const item = document.createElement("div");
        item.className = `tree-item ${entry.is_dir ? "tree-dir" : ""}`;
        item.dataset.path = entry.path;

        // アイコン SVG
        const iconSvg = entry.is_dir
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
           <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
         </svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
           <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
           <polyline points="14,2 14,8 20,8"/>
         </svg>`;

        item.innerHTML = `${iconSvg}<span class="tree-item-name">${entry.name}</span>`;

        // クリックイベント
        item.addEventListener("click", () => {
            if (entry.is_dir) {
                // ディレクトリの場合は中を開く
                loadDirectory(entry.path);
            } else {
                // ファイルの場合は開く
                openFile(entry.path);
            }
        });

        dom.fileTree.appendChild(item);
    });
}

// ─── アクティブファイルのハイライト ───────────────────────
function highlightActiveFile(filePath) {
    document.querySelectorAll(".tree-item").forEach(item => {
        item.classList.toggle("active", item.dataset.path === filePath);
    });
}

// ─── フォルダを開くダイアログ ──────────────────────────────
async function openDirectory() {
    try {
        const dirPath = await openDialog({
            directory: true,
            title: "フォルダを開く",
        });

        if (!dirPath) return; // キャンセル
        await loadDirectory(dirPath);

    } catch (err) {
        if (!String(err).includes("cancel")) {
            showToast(`フォルダを開けませんでした: ${err}`, "error");
        }
    }
}

// ─── 新規ファイル作成ダイアログ ───────────────────────────
async function handleNewFile() {
    try {
        const savePath = await saveDialog({
            filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
            defaultPath: "新規ドキュメント.md",
            title: "新規ファイルの保存先を選択",
        });
        if (!savePath) return;

        // 空のファイルを作成
        await invoke("save_file", { path: savePath, content: "" });

        // 作成したファイルを開く
        await openFile(savePath);
        showToast("新規ファイルを作成しました", "success");
    } catch (err) {
        showToast(`ファイルの作成に失敗: ${err}`, "error");
    }
}

// ─── プレビューの表示/非表示切り替え ─────────────────────
function togglePreview() {
    previewEnabled = !previewEnabled;
    dom.previewPane.classList.toggle("hidden", !previewEnabled);
    dom.paneDivider.style.display = previewEnabled ? "" : "none";
    dom.btnTogglePreview.classList.toggle("active", previewEnabled);

    if (previewEnabled) {
        // 再表示時に最新のプレビューを描画
        updatePreview(editor.getText());
    }
}

// ─── リサイズ機能（サイドバー） ────────────────────────────
function setupSidebarResize() {
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    dom.sidebarResize.addEventListener("mousedown", (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = dom.sidebar.offsetWidth;
        dom.sidebarResize.classList.add("dragging");
        document.body.style.cursor = "ew-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!isResizing) return;
        const delta = e.clientX - startX;
        const newWidth = Math.min(Math.max(startWidth + delta, 160), 480);
        dom.sidebar.style.width = `${newWidth}px`;
    });

    document.addEventListener("mouseup", () => {
        if (!isResizing) return;
        isResizing = false;
        dom.sidebarResize.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    });
}

// ─── リサイズ機能（ペイン区切り） ─────────────────────────
function setupPaneDividerResize() {
    let isResizing = false;
    let startX = 0;
    let startEditorFlex = 0;

    dom.paneDivider.addEventListener("mousedown", (e) => {
        isResizing = true;
        startX = e.clientX;
        const editorPane = document.querySelector(".editor-pane");
        // flex-grow の現在値を数値として取得
        startEditorFlex = parseFloat(getComputedStyle(editorPane).flexGrow) || 1;
        dom.paneDivider.classList.add("dragging");
        document.body.style.cursor = "ew-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!isResizing) return;
        // ドラッグ量に応じてエディタとプレビューの比率を変更する（簡易実装）
        const delta = e.clientX - startX;
        const container = document.querySelector(".app-container");
        const totalWidth = container.offsetWidth - dom.sidebar.offsetWidth;
        const newEditorWidth = Math.min(
            Math.max((e.clientX - dom.sidebar.offsetWidth), totalWidth * 0.2),
            totalWidth * 0.8
        );
        const editorPane = document.querySelector(".editor-pane");
        const previewPane = document.querySelector(".preview-pane");
        editorPane.style.flex = "none";
        editorPane.style.width = `${newEditorWidth}px`;
        previewPane.style.flex = "1";
    });

    document.addEventListener("mouseup", () => {
        if (!isResizing) return;
        isResizing = false;
        dom.paneDivider.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
    });
}

// ─── ウィンドウボタン（最小化・最大化・閉じる） ───────────
function setupWindowControls() {
    dom.btnMinimize.addEventListener("click", () => appWindow.minimize());
    dom.btnMaximize.addEventListener("click", async () => {
        // Tauri v1 に toggleMaximize() はないため自前で切り替える
        const maximized = await appWindow.isMaximized();
        if (maximized) {
            await appWindow.unmaximize();
        } else {
            await appWindow.maximize();
        }
    });
    dom.btnClose.addEventListener("click", () => appWindow.close());
}

// ─── キーボードショートカット ─────────────────────────────
function setupKeyboardShortcuts() {
    document.addEventListener("keydown", async (e) => {
        // Ctrl+S = 保存
        if (e.ctrlKey && !e.shiftKey && e.key === "s") {
            e.preventDefault();
            await saveFile();
        }
        // Ctrl+Shift+S = 名前をつけて保存
        if (e.ctrlKey && e.shiftKey && e.key === "S") {
            e.preventDefault();
            await saveFile(true);
        }
        // Ctrl+O = ファイルを開く
        if (e.ctrlKey && e.key === "o") {
            e.preventDefault();
            await openFile();
        }
        // Ctrl+Shift+P = プレビュー切り替え
        if (e.ctrlKey && e.shiftKey && e.key === "P") {
            e.preventDefault();
            togglePreview();
        }
    });
}

// ─── ファイル変更イベントの受信（Rustから） ───────────────
async function setupFileWatcher() {
    await listen("file-changed", async (event) => {
        const changedPaths = event.payload;

        // 現在開いているファイルが変更されたかチェック
        if (currentFilePath && changedPaths.includes(currentFilePath)) {
            // 自動保存タイマーをリセット（自分の保存による誤検知を避ける）
            clearTimeout(autoSaveTimer);

            // 少し待ってから再読み込み（書き込み完了を待つ）
            setTimeout(async () => {
                try {
                    const fileData = await invoke("read_file", { path: currentFilePath });

                    // エディタの内容と異なる場合のみ更新（自分が書いた変更は無視）
                    if (fileData.content !== editor.getText()) {
                        editor.setText(fileData.content);
                        updatePreview(fileData.content);
                        updateStats(fileData.content);
                        showToast("ファイルが外部で変更されました。再読み込みしました。", "warning");
                    }
                } catch (err) {
                    console.error("ファイルの再読み込みエラー:", err);
                }
            }, 200);
        }

        // ディレクトリが変更された場合はサイドバーを更新
        if (currentDirPath) {
            const dirChanged = changedPaths.some(p => p.startsWith(currentDirPath));
            if (dirChanged) {
                try {
                    const entries = await invoke("read_dir", { path: currentDirPath });
                    renderFileTree(entries);
                    if (currentFilePath) highlightActiveFile(currentFilePath);
                } catch (err) {
                    // サイドバーの更新失敗はサイレントに
                }
            }
        }
    });
}

// ─── HTMLコピー ───────────────────────────────────────────
async function copyHtml() {
    try {
        const html = await invoke("parse_markdown", { text: editor.getText() });
        await navigator.clipboard.writeText(html);
        showToast("HTMLをクリップボードにコピーしました ✓", "success");
    } catch (err) {
        showToast("コピーに失敗しました", "error");
    }
}

// =====================================================================
// ─── 追加機能（最近のファイル・同期スクロール・読み取り専用） ───────────
// =====================================================================

// ─── 最近のファイル管理 ───
const RECENT_FILES_KEY = 'markdownediter_recent_files';

function getRecentFiles() {
    try {
        const files = JSON.parse(localStorage.getItem(RECENT_FILES_KEY)) || [];
        // mdファイルのみ有効
        return files.filter(f => f.path.toLowerCase().endsWith(".md") || f.path.toLowerCase().endsWith(".markdown"));
    }
    catch { return []; }
}

function addRecentFile(path, name) {
    if (!path.toLowerCase().endsWith(".md") && !path.toLowerCase().endsWith(".markdown")) return;
    let files = getRecentFiles();
    files = files.filter(f => f.path !== path);
    files.unshift({ path, name });
    if (files.length > 10) files = files.slice(0, 10);
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(files));
    renderRecentFiles();
}

function renderRecentFiles() {
    const files = getRecentFiles();
    if (files.length === 0) {
        dom.recentFilesList.innerHTML = '';
        dom.recentFilesEmpty.style.display = 'flex';
    } else {
        dom.recentFilesEmpty.style.display = 'none';
        dom.recentFilesList.innerHTML = files.map(f => {
            const isActive = currentFilePath === f.path ? 'active' : '';
            return `<div class="recent-file-item ${isActive}" data-path="${f.path}" title="${f.path}">
                <svg viewBox="0 0 24 24" fill="none" class="recent-file-icon" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                <div class="recent-file-name">${f.name}</div>
            </div>`;
        }).join('');

        dom.recentFilesList.querySelectorAll('.recent-file-item').forEach(item => {
            item.addEventListener('click', () => {
                const p = item.dataset.path;
                if (currentFilePath !== p) openFile(p);
            });
        });
    }
}

// ─── スクロール同期 ───
function setupSyncScroll() {
    const editorScrollContext = editor.view.scrollDOM;
    const previewScrollContext = dom.previewContent; // previewPane ではなく scrollable な previewContent を対象にする

    const onEditorScroll = () => {
        if (syncScrollLock) return;
        syncScrollLock = true;
        const eState = editorScrollContext;
        const pState = previewScrollContext;
        const scrollRatio = eState.scrollTop / (eState.scrollHeight - eState.clientHeight);
        if (!isNaN(scrollRatio) && isFinite(scrollRatio) && pState.scrollHeight > pState.clientHeight) {
            pState.scrollTop = scrollRatio * (pState.scrollHeight - pState.clientHeight);
        }
        setTimeout(() => { syncScrollLock = false; }, 20);
    };

    const onPreviewScroll = () => {
        if (syncScrollLock) return;
        syncScrollLock = true;
        const eState = editorScrollContext;
        const pState = previewScrollContext;
        const scrollRatio = pState.scrollTop / (pState.scrollHeight - pState.clientHeight);
        if (!isNaN(scrollRatio) && isFinite(scrollRatio) && eState.scrollHeight > eState.clientHeight) {
            eState.scrollTop = scrollRatio * (eState.scrollHeight - eState.clientHeight);
        }
        setTimeout(() => { syncScrollLock = false; }, 20);
    };

    editorScrollContext.addEventListener("scroll", onEditorScroll);
    previewScrollContext.addEventListener("scroll", onPreviewScroll);
}

// ─── 読み取り専用モード切り替え ───
function toggleReadonly() {
    readonlyMode = !readonlyMode;
    if (readonlyMode) {
        document.body.classList.add("readonly-mode");
        dom.btnReadonly.classList.add("active");
        if (!previewEnabled) togglePreview(); // プレビューのみになるので強制ON
    } else {
        document.body.classList.remove("readonly-mode");
        dom.btnReadonly.classList.remove("active");
    }
}

// ─── イベントリスナーの登録 ────────────────────────────────
function setupEventListeners() {
    // ツールバーボタン
    dom.btnOpenFile.addEventListener("click", () => openFile());
    dom.btnSave.addEventListener("click", () => saveFile());
    dom.btnSaveAs.addEventListener("click", () => saveFile(true));
    dom.btnTogglePreview.addEventListener("click", () => togglePreview());
    dom.btnReadonly.addEventListener("click", () => toggleReadonly());
    dom.btnCopyHtml.addEventListener("click", () => copyHtml());

    // サイドバーボタン
    dom.btnOpenFileSidebar.addEventListener("click", () => openFile());
    dom.btnOpenDir.addEventListener("click", () => openDirectory());
    if (dom.btnOpenDirEmpty) dom.btnOpenDirEmpty.addEventListener("click", () => openDirectory());
    dom.btnNewFile.addEventListener("click", () => handleNewFile());
}

// =====================================================================
// ─── Markdown書式適用エンジン ─────────────────────────────────────────
// CodeMirror 6 の state/dispatch API を使ってテキストに書式を付与する
// =====================================================================

/**
 * エディタの選択テキストにMarkdown書式を適用する
 * @param {string} format - 書式の種類 ('bold', 'h1', 'ul', ...)
 */
function applyMarkdownFormat(format) {
    const { view } = editor;
    const { state } = view;
    const sel = state.selection.main;
    const selectedText = state.doc.sliceString(sel.from, sel.to);

    // ─ 見出し系（行全体を対象）
    if (["h1", "h2", "h3"].includes(format)) {
        const line = state.doc.lineAt(sel.from);
        const cleanText = line.text.replace(/^#{1,6}\s*/, ""); // 既存の#を除去
        const prefixes = { h1: "# ", h2: "## ", h3: "### " };
        view.dispatch({
            changes: { from: line.from, to: line.to, insert: prefixes[format] + cleanText },
        });
        view.focus();
        return;
    }

    // ─ リスト・引用（選択された全行にプレフィックスを付与）
    if (["ul", "ol", "quote", "checklist"].includes(format)) {
        const startLine = state.doc.lineAt(sel.from);
        const endLine = state.doc.lineAt(sel.to);
        const changes = [];
        let lineIdx = 0;

        for (let i = startLine.number; i <= endLine.number; i++) {
            const line = state.doc.line(i);
            let prefix;
            if (format === "ul") prefix = "- ";
            else if (format === "ol") prefix = `${lineIdx + 1}. `;
            else if (format === "quote") prefix = "> ";
            else if (format === "checklist") prefix = "- [ ] ";
            changes.push({ from: line.from, to: line.from, insert: prefix });
            lineIdx++;
        }

        view.dispatch({ changes });
        view.focus();
        return;
    }

    // ─ コードブロック
    if (format === "codeblock") {
        const inner = selectedText || "ここにコードを入力";
        const insert = "```\n" + inner + "\n```";
        view.dispatch({
            changes: { from: sel.from, to: sel.to, insert },
            selection: { anchor: sel.from + 4, head: sel.from + 4 + inner.length },
        });
        view.focus();
        return;
    }

    // ─ リンク: [テキスト](url) の形で挿入し url 部分を選択状態にする
    if (format === "link") {
        const text = selectedText || "リンクテキスト";
        const insert = `[${text}](url)`;
        // url の位置にカーソルを合わせる
        const urlStart = sel.from + 1 + text.length + 2;
        view.dispatch({
            changes: { from: sel.from, to: sel.to, insert },
            selection: { anchor: urlStart, head: urlStart + 3 }, // "url" を選択
        });
        view.focus();
        return;
    }

    // ─ インライン系（選択範囲を記号で囲む）
    const wrapMap = {
        bold: ["**", "**"],
        italic: ["*", "*"],
        strikethrough: ["~~", "~~"],
        code: ["`", "`"],
    };

    const [open, close] = wrapMap[format] || ["", ""];
    if (!open) return;

    const inner = selectedText || "テキスト";
    const insert = open + inner + close;

    view.dispatch({
        changes: { from: sel.from, to: sel.to, insert },
        // 挿入後、元の文字列の範囲（記号の内側）を選択
        selection: { anchor: sel.from + open.length, head: sel.from + open.length + inner.length },
    });
    view.focus();
}

// =====================================================================
// ─── 右クリック コンテキストメニュー ─────────────────────────────────
// =====================================================================

const ctxMenu = document.getElementById("ctx-menu");

/**
 * コンテキストメニューを指定座標に表示する
 * @param {number} x - 画面X座標
 * @param {number} y - 画面Y座標
 */
function showContextMenu(x, y) {
    ctxMenu.classList.add("visible");

    // 画面外にはみ出さないよう位置を調整
    const menuW = ctxMenu.offsetWidth || 220;
    const menuH = ctxMenu.offsetHeight || 400;
    const left = Math.min(x, window.innerWidth - menuW - 8);
    const top = Math.min(y, window.innerHeight - menuH - 8);

    ctxMenu.style.left = `${Math.max(4, left)}px`;
    ctxMenu.style.top = `${Math.max(4, top)}px`;
}

/** コンテキストメニューを非表示にする */
function hideContextMenu() {
    ctxMenu.classList.remove("visible");
}

/** コンテキストメニューの初期化 */
function setupContextMenu() {
    // エディタエリアで右クリック時
    dom.codemirrorHost.addEventListener("contextmenu", (e) => {
        const { view } = editor;
        const sel = view.state.selection.main;
        const hasSelection = sel.from !== sel.to;

        // テキストが選択されている場合だけカスタムメニューを出す
        if (hasSelection) {
            e.preventDefault();
            showContextMenu(e.clientX, e.clientY);
        }
        // 選択なし → ブラウザデフォルトにフォールバック
    });

    // メニュー項目クリック時の書式適用
    ctxMenu.querySelectorAll(".ctx-item[data-format]").forEach((btn) => {
        btn.addEventListener("mousedown", (e) => {
            e.preventDefault(); // フォーカスをエディタから外さない
            const format = btn.dataset.format;
            hideContextMenu();
            applyMarkdownFormat(format);
        });
    });

    // 他の場所をクリックしたらメニューを閉じる
    document.addEventListener("mousedown", (e) => {
        if (!ctxMenu.contains(e.target)) {
            hideContextMenu();
        }
    });

    // スクロールやESCでも閉じる
    document.addEventListener("scroll", hideContextMenu, true);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideContextMenu();
    });
}

// =====================================================================
// ─── プレビュー画像リサイズ ────────────────────────────────────────────
// プレビュー内の <img> をドラッグでリサイズできるようにする
// リサイズ後に markdown ソースの対応する画像記法を <img width=X> に変換する
// =====================================================================

/**
 * プレビューHTML内の全画像にリサイズハンドルを付与する
 * updatePreview() の後に必ず呼び出す
 */
function makeImagesResizable() {
    dom.previewContent.querySelectorAll("img").forEach((img) => {
        // 既にラップ済みならスキップ（2重処理防止）
        if (img.parentElement && img.parentElement.classList.contains("preview-img-wrapper")) return;

        // ─ ラッパーを作成して img を入れる
        const wrapper = document.createElement("div");
        wrapper.className = "preview-img-wrapper";
        img.parentNode.insertBefore(wrapper, img);
        wrapper.appendChild(img);

        // ─ リサイズハンドル（右下の三角形エリア）
        const handle = document.createElement("div");
        handle.className = "preview-img-resize-handle";
        wrapper.appendChild(handle);

        // ─ サイズ表示ツールチップ
        const tooltip = document.createElement("div");
        tooltip.className = "preview-img-size-tooltip";
        wrapper.appendChild(tooltip);

        // ─ ドラッグイベント
        handle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();

            const startX = e.clientX;
            const startW = img.offsetWidth;
            wrapper.classList.add("resizing");

            const onMove = (e) => {
                const newW = Math.max(50, startW + e.clientX - startX);
                img.style.width = `${newW}px`;
                img.style.height = "auto"; // アスペクト比を維持
                wrapper.style.width = `${newW}px`;
                tooltip.textContent = `${newW}px`;
            };

            const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                wrapper.classList.remove("resizing");

                // リサイズ後に markdown ソースを更新する
                const finalWidth = img.offsetWidth;
                const src = img.getAttribute("src");
                const alt = img.getAttribute("alt") || "";
                if (src && finalWidth) {
                    updateImageSizeInMarkdown(src, alt, finalWidth);
                }
            };

            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
    });
}

/**
 * Markdown ソース内の指定画像を <img width="W"> 形式に書き換える
 * 例: ![alt](src) → <img src="src" alt="alt" width="300">
 * @param {string} src - 画像のsrc属性値
 * @param {string} alt - alt テキスト
 * @param {number} width - 新しい幅（px）
 */
function updateImageSizeInMarkdown(src, alt, width) {
    const text = editor.getText();

    // まずMarkdown記法 ![alt](src) にマッチ
    // エスケープを考慮した正規表現
    const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedAlt = alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // パターン1: Markdown記法 ![alt](src) または ![alt](src "title")
    const mdPattern = new RegExp(`!\\[${escapedAlt}\\]\\(${escapedSrc}(?:\\s+"[^"]*")?\\)`, "g");
    // パターン2: 既存の <img> タグ
    const imgPattern = new RegExp(`<img[^>]*src=["']${escapedSrc}["'][^>]*>`, "gi");

    const newImgTag = `<img src="${src}" alt="${alt || ""}" width="${width}">`;

    let newText = text;
    // Markdown記法を HTML img タグへ置換
    if (mdPattern.test(text)) {
        newText = text.replace(mdPattern, newImgTag);
    } else if (imgPattern.test(text)) {
        newText = text.replace(imgPattern, newImgTag);
    } else {
        // マッチしない場合は何もしない
        return;
    }

    if (newText !== text) {
        editor.setText(newText);
        setSaveState("unsaved");
        showToast(`画像サイズを ${width}px に変更しました`, "success");

        // 自動保存をトリガー
        if (currentFilePath) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = setTimeout(() => autoSave(newText), 1000);
        }
    }
}

// =====================================================================
// ─── アプリの初期化 ────────────────────────────────────────────────────
// =====================================================================

async function loadDefaultGuide() {
    try {
        // スタートガイドのパスを解決して読み込む
        // resolveでカレントディレクトリ基準の絶対パスを取得
        const guidePath = await resolve("スタートガイド.md");
        await openFile(guidePath);
    } catch {
        // フォールバック（初期テキストのままにする）
        const initialText = editor.getText();
        await updatePreview(initialText);
        updateStats(initialText);
        setSaveState("saved");
    }
}

async function init() {
    console.log("[MarkdownEditer] 起動中...");

    // CodeMirror エディタを初期化
    editor = createEditor(dom.codemirrorHost, onEditorChange);

    // ウィンドウコントロールを設定
    setupWindowControls();

    // キーボードショートカットを設定
    setupKeyboardShortcuts();

    // リサイズ機能を設定
    setupSidebarResize();
    setupPaneDividerResize();

    // イベントリスナーを登録
    setupEventListeners();

    // 右クリックコンテキストメニューを設定
    setupContextMenu();

    // スクロール同期設定
    setupSyncScroll();

    // 最近のファイルをレンダリング
    renderRecentFiles();

    // ファイル変更監視のイベント受信を開始
    await setupFileWatcher();

    // 初期ドキュメントを読み込み（最近使ったファイル、なければスタートガイド）
    const recent = getRecentFiles();
    if (recent.length > 0) {
        try {
            await openFile(recent[0].path);
        } catch {
            await loadDefaultGuide();
        }
    } else {
        await loadDefaultGuide();
    }

    console.log("[MarkdownEditer] 初期化完了");
}

// DOM が読み込まれたら起動
document.addEventListener("DOMContentLoaded", init);
