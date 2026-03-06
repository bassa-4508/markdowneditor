# MarkdownEditer

Tauri + Rust + CodeMirror 6 を用いて構築された、軽量かつ高速な Markdown エディタです。

![MarkdownEditer](https://github.com/placeholder/markdownediter/blob/main/screenshot.png?raw=true)

## 主な機能

- ⚡ **超高速＆軽量**: Rust バックエンドによる高速なファイル I/O と、プレーンな JavaScript によるフロントエンドでサクサク動作します。
- 👁️ **リアルタイムプレビュー**: 左ペインでの編集内容が右ペインに瞬時に反映されます。スクロールも完全に同期します。
- 🧮 **数式サポート**: MathJax 3 による TeX 記法のインライン・ディスプレイ数式に対応しています。
- 📊 **Mermaid & PlantUML**: フローチャートやシーケンス図などの高度なダイアグラムをサポートしています。
- 🖼️ **画像のリサイズ**: プレビュー上で画像をドラッグして直感的にリサイズ可能です。
- 📁 **ファイル・フォルダ管理**: 最近使ったファイルの記憶や、ディレクトリツリーからの直感的なファイル操作をサポートします。

## インストール方法

### 開発環境のセットアップ

1. **Rustのインストール**  
   [Rust公式サイト](https://rustup.rs/) から `rustup` を使ってインストールします。
2. **Node.jsのインストール**  
   [Node.js公式サイト](https://nodejs.org/) から推奨版をインストールします。

### ビルド手順

```bash
# リポジトリのクローン
git clone https://github.com/yourusername/markdownediter.git
cd markdownediter

# 依存関係のインストール
npm install

# 開発モードでの起動
npm run tauri dev

# 本番用ビルド（インストーラーの作成）
npm run tauri build
```

ビルドが完了すると、`src-tauri/target/release/bundle/` ディレクトリ内にインストーラ（`.msi` または `.exe` など）が生成されます。

## 機能のハイライト

- **同期スクロール**: 長いドキュメントでも、エディタとプレビューが同じ場所を指し示します。
- **読み取り専用モード**: エディタを隠し、プレビューだけをフルスクリーンで表示できます。
- **右クリックメニュー**: テキストを選択して右クリックするだけで、太字や見出しなどの Markdown 装飾が簡単に適用できます。

## ライセンス

このプロジェクトは MIT ライセンスの下で公開されています。詳細については [LICENSE](LICENSE) ファイルをご覧ください。
