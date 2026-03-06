import { defineConfig } from "vite";

// Tauri が使う開発サーバーの設定
// 参考: https://tauri.app/v1/guides/getting-started/setup/vite
export default defineConfig({
  // Vite のルートを src/ に設定（index.html がここにある）
  root: "src",

  // ブラウザ向けではなくデスクトップ向けなのでホストを全許可
  server: {
    port: 1420,
    strictPort: true,
  },

  // ビルド出力先を src-tauri の tauri.conf.json 内 distDir と一致させる
  // root が src/ なので、相対パスは ../dist になる → プロジェクトルートの dist/
  build: {
    outDir: "../dist",
    emptyOutDir: true, // ビルド前に dist を削除してクリーンにする
  },

  // .js ファイルで ES モジュールを使用
  esbuild: {
    target: "es2020",
  },
});
