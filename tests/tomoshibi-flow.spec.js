// tests/tomoshibi-flow.spec.js
// 灯: 申請（パスワードも登録時に設定） → 管理者ログイン → 承認。承認後のログイン〜サロン画面は tests-e2e-local/salon.e2e.mjs で確認
import { test, expect, request as pwRequest } from '@playwright/test';
import { uniqueEmail, loginAsAdmin } from './helpers.js';

test.describe.serial('灯: 申請から会員ページ・ログアウトまで', () => {
  const email = uniqueEmail('e2e-tomoshibi');
  let passwordSetupToken = null;

  test('1. 申請フォームを送信できる', async ({ page }) => {
    await page.goto('/salon/tomoshibi/register/');
    await page.fill('#fullname', 'Playwright テスト');
    await page.fill('#fullnamekana', 'ぷれいらいと てすと');
    await page.fill('#nickname', 'ぷれいてすと');
    await page.fill('#email', email);
    await page.fill('#password', 'PlaywrightTest-12345');
    await page.fill('#password2', 'PlaywrightTest-12345');
    await page.check('#terms');
    await page.fill('#reason', '自動テストによる申請です。');
    await page.click('#go');
    await expect(page.locator('#okmsg')).toContainText('お申し込みありがとうございます', { timeout: 10_000 });
  });

  test('2. 管理者が個別アカウントでログインし、申請一覧に表示される', async ({ playwright, baseURL }) => {
    const adminCtx = await loginAsAdmin(playwright, baseURL);
    const res = await adminCtx.get('/api/admin?action=applications&community=tomoshibi');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const found = body.applications.find((a) => a.email === email);
    expect(found).toBeTruthy();
    await adminCtx.dispose();
  });

  test('3. 管理者が承認できる', async ({ playwright, baseURL }) => {
    const adminCtx = await loginAsAdmin(playwright, baseURL);
    const res = await adminCtx.post('/api/admin?action=approve', { data: { community: 'tomoshibi', email } });
    expect(res.status()).toBe(200);
    await adminCtx.dispose();
    // 承認のお知らせメールの実受信は自動テストの対象外（Resendはexample.com宛の送信をブロックするため）。
  });

  test.skip('4. 承認後のログイン→サロン画面 (Previewの実アカウントでの手動確認。ローカルでは salon.e2e.mjs で確認済み)', async () => {});
});
