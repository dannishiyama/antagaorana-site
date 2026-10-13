/**
 * api/_lib/audit-scope.js
 * 管理者の操作履歴（監査ログ）を、サービス（HAKU Community／教育者のサロン 灯）ごとに分けるための判定。
 * 保存先は共通の監査ログのまま。表示のときだけ、どちらのサービスの操作かで分ける（保存・権限は変更しない）。
 *   灯の操作：action が salon_ で始まる／metadata に salon／metadata.community が tomoshibi
 *   HAKUの操作：上記以外（管理者ログインなど、サービスをまたぐ操作も、HAKU側に含める）
 */
export function isSalonAudit(entry) {
  const a = String(entry?.action || '');
  const m = entry?.metadata || {};
  return a.startsWith('salon_') || Boolean(m.salon) || m.community === 'tomoshibi';
}
export const filterAuditByService = (entries, service) => (service === 'salon' ? entries.filter(isSalonAudit) : service === 'haku' ? entries.filter((e) => !isSalonAudit(e)) : entries);
