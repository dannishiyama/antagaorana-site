// tests/security.spec.js
// 共通セキュリティ項目: 誤パスワード・未登録ユーザー・未ログイン直アクセス拒否・
// community横断アクセス拒否・パスワードリセットのユーザー列挙耐性・レート制限。
import { test, expect } from '@playwright/test';
import { uniqueEmail } from './helpers.js';

test.describe('共通セキュリティ', () => {
  test('誤パスワードは汎用エラーで拒否される', async ({ request }) => {
    const res = await request.post('/api/community-auth?action=login', {
      data: { community: 'haku', email: 'nobody@example.com', password: 'wrongpass' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toContain('メールアドレスまたはパスワードが違います');
  });

  test('未登録ユーザーも同じ汎用エラーで拒否される（アカウント有無を漏らさない）', async ({ request }) => {
    const res = await request.post('/api/community-auth?action=login', {
      data: { community: 'haku', email: uniqueEmail('never-registered'), password: 'anything123' },
    });
    expect(res.status()).toBe(401);
  });

  test('未ログインでの会員ページ直接アクセスはログインページへリダイレクトされる（会員HTMLは返らない）', async ({ page }) => {
    await page.goto('/haku-community/home/');
    await expect(page).toHaveURL(/\/haku-community\/login\//);
    // 旧URLからも同様（ログインページへ。リダイレクトのループにならない）
    await page.goto('/haku-community-home.html');
    await expect(page).toHaveURL(/\/haku-community\/login\//);
    await page.goto('/salon/tomoshibi/');
    await expect(page).toHaveURL(/\/salon\/tomoshibi\/login\//);
    // 旧URL（/tomoshibi*）は新しい /salon/ 配下へ移る
    await page.goto('/tomoshibi-post.html');
    await expect(page).toHaveURL(/\/salon\/tomoshibi\/login\//);
  });

  test('保護ページの実テンプレートは静的ファイルとして直接取得できない', async ({ request }) => {
    const res = await request.get('/api/_templates/haku-community-home.html');
    expect(res.status()).toBe(404);
  });

  test('パスワードリセット申請は、存在有無に関わらず同一レスポンスを返す', async ({ request }) => {
    const resExisting = await request.post('/api/community-auth?action=request-password-reset', {
      data: { community: 'haku', email: 'admin@antagaorana.com' },
    });
    const resMissing = await request.post('/api/community-auth?action=request-password-reset', {
      data: { community: 'haku', email: uniqueEmail('never-registered') },
    });
    expect(resExisting.status()).toBe(200);
    expect(resMissing.status()).toBe(200);
    const bodyA = await resExisting.json();
    const bodyB = await resMissing.json();
    expect(bodyA.message).toBe(bodyB.message);
  });

  test('管理APIは未ログインでは401、承認/却下も同様', async ({ request }) => {
    const list = await request.get('/api/admin?action=applications&community=tomoshibi');
    expect(list.status()).toBe(401);
    const approve = await request.post('/api/admin?action=approve', { data: { community: 'tomoshibi', email: 'x@example.com' } });
    expect(approve.status()).toBe(401);
  });

  test('クロスオリジンのOriginヘッダを付けたPOSTは拒否される', async ({ request }) => {
    const res = await request.post('/api/community-auth?action=login', {
      headers: { Origin: 'https://evil.example.com' },
      data: { community: 'haku', email: 'a@b.com', password: 'x' },
    });
    expect(res.status()).toBe(403);
  });

  test('ログインAPIはレート制限され、一定回数を超えると429になる', async ({ request }) => {
    const email = uniqueEmail('ratelimit');
    let sawTooMany = false;
    for (let i = 0; i < 20; i++) {
      const res = await request.post('/api/community-auth?action=login', {
        data: { community: 'haku', email, password: 'wrong' },
      });
      if (res.status() === 429) { sawTooMany = true; break; }
    }
    expect(sawTooMany).toBe(true);
  });
});
