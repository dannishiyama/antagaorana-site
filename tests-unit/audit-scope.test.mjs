import test from 'node:test';
import assert from 'node:assert/strict';
import { isSalonAudit, filterAuditByService } from '../api/_lib/audit-scope.js';

const E = [
  { action: 'salon_application_approve', metadata: {} },
  { action: 'application_approve', metadata: { community: 'tomoshibi' } },
  { action: 'application_approve', metadata: { community: 'haku' } },
  { action: 'points_grant', metadata: {} },
  { action: 'member_note', metadata: { salon: true } },
];

test('灯の操作の判定：salon_ で始まる／metadata.salon／community=tomoshibi', () => {
  assert.deepEqual(E.map(isSalonAudit), [true, true, false, false, true]);
});

test('サービス別の絞り込み：HAKU・灯は互いに混ざらない', () => {
  const haku = filterAuditByService(E, 'haku');
  const salon = filterAuditByService(E, 'salon');
  assert.equal(haku.length + salon.length, E.length);
  assert.ok(!haku.some(isSalonAudit));
  assert.ok(salon.every(isSalonAudit));
  assert.equal(filterAuditByService(E, null).length, E.length);
});
