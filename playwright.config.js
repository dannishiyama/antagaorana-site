// playwright.config.js
// HAKU Community / 教育者のサロン 灯 の主要フローをPreview環境に対して検証するE2Eテスト設定。
// 実行対象は固定Preview URL（antagaorana-haku-tomoshibi-preview.vercel.app）。
// 本番URLに向けて実行しないこと（api/_lib/http.js の blockProduction によりPreview以外では
// そもそもAPIが403で拒否されるため、誤って本番へ向けても実害はない設計になっている）。
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || 'https://antagaorana-haku-tomoshibi-preview.vercel.app';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // Redis上の共有状態（レート制限・申請一覧）を扱うため直列実行を基本とする
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-390', use: { viewport: { width: 390, height: 844 } } },
  ],
});
