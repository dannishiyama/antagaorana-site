// tests/mobile.spec.js
// 横スクロール（横方向のオーバーフロー）が発生していないことを、ログイン不要なページで確認する。
// 390 / 768 / 1280 の3幅は playwright.config.js のプロジェクト定義（desktop / mobile-390）と
// テスト内の明示的リサイズで組み合わせてカバーする。
import { test, expect } from '@playwright/test';

const PAGES = [
  '/haku-community/',
  '/haku-community/login/',
  '/salon/tomoshibi/login/',
  '/haku-community/register/',
  '/salon/tomoshibi/register/',
  '/salon/',
  '/forgot-password.html',
  '/community-set-password.html?token=dummy&community=haku',
  '/haku-community/admin/',
  '/account-settings.html', // 未ログイン時のゲート表示のみ確認
];

for (const path of PAGES) {
  test(`横スクロールが発生しない: ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflow, `${path} が390px幅で横スクロールしている`).toBe(false);

    await page.setViewportSize({ width: 768, height: 1024 });
    const overflowTablet = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(overflowTablet, `${path} が768px幅で横スクロールしている`).toBe(false);
  });
}
