import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareTime, concatPieces, oneMinuteBefore, sha256 } from './lib/digest.mjs';
import {
  buildCaseView, buildObligations, entranceUsableAt, recommendAction, verifySeal, withdrawalImpact,
} from './lib/dossier.mjs';

const H1 = '1111111111111111111111111111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222222222222222222222222222';

/** 构造与 Ledger.project() 同构的最小投影，便于纯函数测试。 */
function projection(overrides = {}) {
  return {
    events: [],
    declarations: new Map(),
    entrances: new Map(),
    receipts: new Map(),
    seals: [],
    custody: new Map(),
    fetchAttempts: [],
    impactSnapshots: [],
    reuseRecords: [],
    maxStage: 4,
    ...overrides,
  };
}

const declaration = (caseId, declarationId, content, parties, extra = {}) =>
  ({ case: caseId, leg: 'RAIL', declaration: declarationId, content, parties, ...extra });
const entrance = (id, caseId, declarationId, pieces, extra = {}) => ({
  entrance: id, case: caseId, declaration: declarationId, pieces,
  currentUntil: '17:00', withdrawnAt: null, ...extra,
});

test('摘要工具：拼接次序参与身份，时刻回退处理跨整点', () => {
  assert.equal(sha256(Buffer.from('abc')), sha256(Buffer.from('abc')));
  assert.notEqual(sha256(concatPieces([Buffer.from('a'), Buffer.from('b')])),
    sha256(concatPieces([Buffer.from('b'), Buffer.from('a')])));
  assert.equal(oneMinuteBefore('15:20'), '15:19');
  assert.equal(oneMinuteBefore('15:00'), '14:59');
  assert.equal(oneMinuteBefore('00:00'), '00:00');
  assert.equal(compareTime('14:55', '15:20'), -1);
  assert.equal(compareTime('15:20', '15:20'), 0);
});

test('入口可用性：撤下时刻与有效期两个边界都生效', () => {
  const live = entrance('V1', 'A11', 'DEC79', ['x.txt']);
  assert.equal(entranceUsableAt(live, '14:55'), true);

  const revoked = entrance('V1', 'A11', 'DEC79', ['x.txt'], { withdrawnAt: '14:55' });
  assert.equal(entranceUsableAt(revoked, '14:55'), false); // 撤下时刻 <= at
  assert.equal(entranceUsableAt(revoked, '14:54'), true);

  const shortWindow = entrance('V2', 'A11', 'DEC79', ['x.txt'], { currentUntil: '15:20' });
  assert.equal(entranceUsableAt(shortWindow, '15:20'), false); // at >= 有效期
  assert.equal(entranceUsableAt(shortWindow, '15:19'), true);
});

test('处置建议四分支：已收悉、补送、补领、退请说明', () => {
  const base = projection({
    declarations: new Map([
      ['DEC79', declaration('A11', 'DEC79', H1, ['甲方', '乙方'])],
      ['DEC81', declaration('A11', 'DEC81', H1, ['甲方'])],
      ['DEC99', declaration('A11', 'DEC99', H2, ['甲方'])],
    ]),
    entrances: new Map([
      ['V51', entrance('V51', 'A11', 'DEC79', ['a.txt'])],
      ['V53', entrance('V53', 'A11', 'DEC81', ['a.txt'])],
    ]),
    receipts: new Map([
      ['A11|甲方|DEC79', [{ case: 'A11', party: '甲方', declaration: 'DEC79', content: H1, receipt: 'R13' }]],
    ]),
  });

  const find = (p) => (party, id) =>
    buildObligations(p).find((o) => o.party === party && o.declaration === id);
  const findIn = find(base);

  // 已收悉且内容一致
  assert.equal(recommendAction(findIn('甲方', 'DEC79'), base, '14:55').action, 'done');
  // 未收悉 + 未在管 + 授权有效 → 补领
  assert.equal(recommendAction(findIn('乙方', 'DEC79'), base, '14:55').action, 'retrieve');
  assert.equal(recommendAction(findIn('甲方', 'DEC81'), base, '14:55').action, 'retrieve');
  // 未收悉 + 从未发布取件号 + 未在管 → 退请说明
  assert.equal(recommendAction(findIn('甲方', 'DEC99'), base, '14:55').action, 'return_for_explanation');

  // 原件核验在管后，未收悉关系从补领转为补送（同内容复用已获准保管的原件）
  const inCustody = projection({ ...base, custody: new Map([[H1, { digest: H1 }]]) });
  const findCustodied = find(inCustody);
  assert.equal(recommendAction(findCustodied('乙方', 'DEC79'), inCustody, '14:55').action, 'serve');

  // 唯一入口撤下后，补领转为退请说明（已不能取到）
  const revoked = projection({
    ...base,
    entrances: new Map([
      ['V51', entrance('V51', 'A11', 'DEC79', ['a.txt'])],
      ['V53', entrance('V53', 'A11', 'DEC81', ['a.txt'], { withdrawnAt: '14:55' })],
    ]),
  });
  assert.equal(recommendAction(find(revoked)('甲方', 'DEC81'), revoked, '14:55').action, 'return_for_explanation');
});

test('撤下发生在回执之前：待送关系进入停止清单，事后回执只补历史不改快照', () => {
  const before = projection({
    declarations: new Map([['DEC79', declaration('A11', 'DEC79', H1, ['甲方', '乙方'])]]),
    entrances: new Map([
      ['V51', entrance('V51', 'A11', 'DEC79', ['a.txt'], { withdrawnAt: '14:55' })],
    ]),
    receipts: new Map(),
  });
  const impact = withdrawalImpact('V51', before, '14:55');
  assert.deepEqual(new Set(impact.stopped.map((s) => s.party)), new Set(['甲方', '乙方']));
  assert.deepEqual(impact.historyOnly, []);
  // 之后甲方回执补到：甲方转为仅历史可查，乙方仍在停止清单；撤下时刻的快照结论不被回写
  const after = projection({
    ...before,
    receipts: new Map([
      ['A11|甲方|DEC79', [{ case: 'A11', party: '甲方', declaration: 'DEC79', content: H1, receipt: 'R13' }]],
    ]),
  });
  const later = withdrawalImpact('V51', after, '14:55');
  assert.deepEqual(later.stopped.map((s) => s.party), ['乙方']);
  assert.deepEqual(later.historyOnly.map((s) => s.party), ['甲方']);
  assert.deepEqual(new Set(impact.stopped.map((s) => s.party)), new Set(['甲方', '乙方']));
});

test('回执摘要与声明不一致时不承认收悉，退请说明', () => {
  const p = projection({
    declarations: new Map([['DEC79', declaration('A11', 'DEC79', H1, ['甲方'])]]),
    entrances: new Map([['V51', entrance('V51', 'A11', 'DEC79', ['a.txt'])]]),
    receipts: new Map([
      ['A11|甲方|DEC79', [{ case: 'A11', party: '甲方', declaration: 'DEC79', content: H2, receipt: 'R99' }]],
    ]),
  });
  const obligation = buildObligations(p)[0];
  assert.equal(obligation.served, true);
  assert.equal(obligation.contentMatched, false);
  assert.equal(recommendAction(obligation, p, '14:55').action, 'return_for_explanation');
});

test('撤下影响严格按入口作用域隔离，同内容他案授权只作独立登记', () => {
  const p = projection({
    declarations: new Map([
      ['DEC79', declaration('A11', 'DEC79', H1, ['甲方', '乙方'])],
      ['DEC18', declaration('A12', 'DEC18', H1, ['丙方'])],
    ]),
    entrances: new Map([
      ['V51', entrance('V51', 'A11', 'DEC79', ['a.txt'], { withdrawnAt: '14:55' })],
      ['V52', entrance('V52', 'A12', 'DEC18', ['b.txt'])],
    ]),
    receipts: new Map([
      ['A11|甲方|DEC79', [{ case: 'A11', party: '甲方', declaration: 'DEC79', content: H1, receipt: 'R13' }]],
    ]),
  });
  const impact = withdrawalImpact('V51', p, '14:55');
  assert.deepEqual(impact.scope, { case: 'A11', declaration: 'DEC79' });
  assert.deepEqual(impact.stopped.map((s) => s.party), ['乙方']);
  assert.deepEqual(impact.historyOnly.map((s) => s.party), ['甲方']);
  assert.deepEqual(impact.independent.map((s) => s.case), ['A12']);

  // 同内容在管也不得让 A12 丙方看到 A11 的声明或回执
  p.custody.set(H1, { digest: H1, entrance: 'V51', case: 'A11', declaration: 'DEC79' });
  const a12 = buildCaseView('A12', p, '14:55');
  assert.deepEqual(a12.obligations.map((o) => o.declaration), ['DEC18']);
  assert.ok(a12.originals.every((o) => !o.relatedDeclarations.includes('DEC79')));
});

test('封存核验：虚假回执与错误缺件标记都能被查出', () => {
  const p = projection({
    declarations: new Map([['DEC79', declaration('A11', 'DEC79', H1, ['甲方', '乙方'])]]),
    entrances: new Map(),
    receipts: new Map([
      ['A11|甲方|DEC79', [{ case: 'A11', party: '甲方', declaration: 'DEC79', content: H1, receipt: 'R13' }]],
    ]),
  });
  const good = verifySeal({ case: 'A11', volume: 'VL1', time: '14:30', known: ['R13'], outstanding: ['乙方/DEC79'] }, p);
  assert.equal(good.valid, true);

  const fakeReceipt = verifySeal({ case: 'A11', volume: 'VL2', time: '14:31', known: ['R404'], outstanding: [] }, p);
  assert.equal(fakeReceipt.valid, false);
  assert.equal(fakeReceipt.known[0].exists, false);

  const wrongOutstanding = verifySeal({ case: 'A11', volume: 'VL3', time: '14:32', known: ['R13'], outstanding: ['甲方/DEC79'] }, p);
  assert.equal(wrongOutstanding.valid, false);
  assert.equal(wrongOutstanding.outstanding[0].stillOutstanding, false);
});

test('修订件视图保留版本链与差异，且不覆盖原件', () => {
  const p = projection({
    declarations: new Map([
      ['DEC79', declaration('A11', 'DEC79', H1, ['甲方'])],
      ['DEC79-R2', declaration('A11', 'DEC79-R2', H2, ['甲方'], { replaces: 'DEC79' })],
    ]),
    entrances: new Map([
      ['V51', entrance('V51', 'A11', 'DEC79', ['a.txt'])],
      ['V55', entrance('V55', 'A11', 'DEC79-R2', ['clear.txt'])],
    ]),
    receipts: new Map(),
  });
  const view = buildCaseView('A11', p, '14:55');
  assert.deepEqual([...new Set(view.originals.map((o) => o.content))].sort(), [H1, H2]);
  const revision = view.revisions[0];
  assert.equal(revision.contentChanged, true);
  assert.equal(revision.fromContent, H1);
  assert.equal(revision.toContent, H2);
  const original = view.declarations.find((d) => d.declaration === 'DEC79');
  assert.equal(original.revisedBy, 'DEC79-R2');
  assert.equal(original.kind, 'declaration');
});
