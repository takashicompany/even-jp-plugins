import { defineConfig } from 'vite'

// 取り込み側 (イーブン) は <base href="プラグインURL"> を注入したうえでHTMLを展開するため、
// アセット参照は相対パスにしておく必要がある。
export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5184,
    allowedHosts: true,
  },
})
