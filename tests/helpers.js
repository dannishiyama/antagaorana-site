// tests/helpers.js
// Playwright APIRequestContext だけで完結する共通ヘルパー（Redis上の申請/会員状態を
// UI操作なしで作るための実務的なショートカット。実際のUIフローもtomoshibi-flow.spec.js /
// account-settings.spec.js で別途カバーする）。
export function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

export async function apiPost(request, path, data) {
  const res = await request.post(path, { data });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

export async function apiGet(request, path) {
  const res = await request.get(path);
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

// 個別管理者アカウントでログインし、admin_session Cookieを持つ新しいAPIRequestContextを返す。
// E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD は事前に admin-community.html の「初回管理者アカウント
// 作成」から作っておいた、テスト専用の管理者アカウントを想定する（本番の管理者アカウントを
// テストに使い回さないこと）。
export async function loginAsAdmin(playwright, baseURL) {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD が設定されていません。tests/README.md を参照してください。');
  }
  const context = await playwright.request.newContext({ baseURL });
  const res = await context.post('/api/admin?action=login', { data: { email, password } });
  if (res.status() !== 200) throw new Error(`admin login failed: ${res.status()} ${await res.text()}`);
  return context;
}
