import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { start } from './source-server.mjs';
import { SourceClient } from './lib/source-client.mjs';
import { Ledger } from './lib/ledger.mjs';
import { Ingestor } from './lib/ingest.mjs';
import { buildCaseView, withdrawalImpact } from './lib/dossier.mjs';
import { sha256 } from './lib/digest.mjs';

async function freshWorkDir() {
  return mkdtemp(join(tmpdir(), 'arb-ledger-'));
}

async function syncAll(url, workDir) {
  const client = new SourceClient(url);
  const ledger = new Ledger(workDir);
  await ledger.open();
  const ingestor = new Ingestor(client, ledger);
  const summary = await ingestor.run();
  return { client, ledger, summary };
}

test('分阶段回放：来源事实全部入账且只追加一次', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const workDir = await freshWorkDir();
  const { summary, ledger } = await syncAll(url, workDir);

  assert.deepEqual(summary.ingested, { manifest: 4, pickup: 3, withdraw: 1, receipt: 2, seal: 1 });

  const events = await ledger.events();
  const sourceEvents = events.filter((e) => e.dedupKey);
  const sourceRecords = sourceEvents.map((e) => e.sourceRecord);
  assert.equal(sourceRecords.length, new Set(sourceRecords).size);
  assert.equal(sourceRecords.length, 11); // 4 清单 + 3 取件 + 1 撤下 + 2 回执 + 1 封存

  // 再次同步是幂等的：不产生重复来源事件
  const second = await syncAll(url, workDir);
  assert.deepEqual(second.summary.ingested, { manifest: 0, pickup: 0, withdraw: 0, receipt: 0, seal: 0 });
  const sourceEventsAgain = (await second.ledger.events()).filter((e) => e.dedupKey);
  assert.equal(sourceEventsAgain.length, sourceEvents.length);
});

test('分段按序拼接核摘要后入管；同内容复用不重复落盘', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const workDir = await freshWorkDir();
  const { ledger } = await syncAll(url, workDir);
  const projection = await ledger.project();

  // V51 两段拼接 = handoff.txt 的内容摘要；V52 同内容走复用；V55 修订件是另一份内容
  const digest12 = '12d5425c51c66635ac00ec872b8a83ed53b1a3363d577ae8c1670a1be8e4e75c';
  const digestClear = 'df483ed24ef0579b491cb89a43238216a282f258899dcb1e08704fc51821d41f';
  assert.deepEqual([...projection.custody.keys()].sort(), [digest12, digestClear]);

  const files = await readdir(join(workDir, 'custody'));
  assert.deepEqual(files.sort(), [`${digest12}.bin`, `${digestClear}.bin`]);
  const bytes = await readFile(join(workDir, 'custody', `${digest12}.bin`));
  assert.equal(sha256(bytes), digest12);
  assert.equal(bytes.toString('utf8'), '轨道段封条仍在。交接方记录。\n');

  // 同内容的第二个授权入口只登记复用，不另存一份，也不扩权
  const reuse = projection.reuseRecords.find((r) => r.entrance === 'V52');
  assert.ok(reuse);
  assert.equal(reuse.digest, digest12);

  // 摄入期内的取件尝试全部成功（撤下发生在这些取件之后）
  assert.ok(projection.fetchAttempts.every((attempt) => attempt.ok));
});

test('撤下后原入口取件被拒；撤下影响快照在入账时固化并可与现状对照', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const workDir = await freshWorkDir();
  const { client, ledger } = await syncAll(url, workDir);

  // 撤下后再用 V51 取件，托管端明确拒绝
  await client.setStage(4);
  const denied = await client.fetchPiece('handoff-a.txt', { entrance: 'V51', case: 'A11', at: '15:19' });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);
  // 案卷与取件号不符同样拒绝：同内容的他案入口不能挪用到本案
  const wrongCase = await client.fetchPiece('handoff.txt', { entrance: 'V52', case: 'A11', at: '14:55' });
  assert.equal(wrongCase.status, 403);

  const projection = await ledger.project();
  const snapshot = projection.impactSnapshots.find((s) => s.entrance === 'V51');
  // 撤下事件（depot-4）入账时 service-3 的 R14 尚未回放：乙方/DEC79 待送且无其他入口 → 停止；
  // 甲方已有 R13 → 仅历史可查。影响严格限定 V51 的案卷/声明作用域，DEC81 不混入。
  assert.deepEqual(snapshot.stopped.map((s) => `${s.party}/${s.declaration}`), ['乙方/DEC79']);
  assert.deepEqual(snapshot.historyOnly.map((s) => `${s.party}/${s.declaration}`), ['甲方/DEC79']);
  // 同内容在 A12 仍有独立授权 V52，但授权范围隔离
  assert.deepEqual(snapshot.independent.map((s) => `${s.case}/${s.entrance}`), ['A12/V52']);

  // 按当前时刻（R14 已入账）重算：乙方转为仅历史可查，停止清单清空；历史快照不被回写
  const current = withdrawalImpact('V51', projection, '14:55');
  assert.deepEqual(current.stopped, []);
  assert.deepEqual(new Set(current.historyOnly.map((s) => s.party)), new Set(['甲方', '乙方']));
  assert.deepEqual(current.independent.map((s) => s.entrance), ['V52']);
});

test('封存边界核验：已收悉与缺件可复查，卷外关系不混入缺件', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const workDir = await freshWorkDir();
  const { ledger } = await syncAll(url, workDir);
  const projection = await ledger.project();

  const seal = projection.seals.find((s) => s.volume === 'VL1');
  const check = seal.verification;
  assert.equal(check.valid, true);
  assert.deepEqual(check.known, [{
    receipt: 'R13', exists: true, party: '甲方', declaration: 'DEC79',
    content: '12d5425c51c66635ac00ec872b8a83ed53b1a3363d577ae8c1670a1be8e4e75c',
  }]);
  const outstanding = check.outstanding[0];
  assert.equal(outstanding.token, '乙方/DEC79');
  assert.equal(outstanding.stillOutstanding, true);
  // R14 晚到后只在重算视图体现，封存事件本身不被改写
  assert.deepEqual(outstanding.laterReceipts, []);
  // 封存时 DEC81 已存在但不在本卷范围内，单独列为卷外关系
  assert.deepEqual(check.outOfScope.map((o) => `${o.party}/${o.declaration}`), ['甲方/DEC81']);
});

test('案卷视图显式区分原件、关联声明与后续修订，修订件独立送阅不互算回执', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const workDir = await freshWorkDir();
  const { ledger } = await syncAll(url, workDir);
  const projection = await ledger.project();
  const view = buildCaseView('A11', projection, '14:55');

  const digest12 = '12d5425c51c66635ac00ec872b8a83ed53b1a3363d577ae8c1670a1be8e4e75c';
  const digestClear = 'df483ed24ef0579b491cb89a43238216a282f258899dcb1e08704fc51821d41f';

  // 原件层：同一摘要被 DEC79 与 DEC81 两个声明引用，仍只是一份原件
  const shared = view.originals.find((o) => o.content === digest12);
  assert.deepEqual(shared.relatedDeclarations.sort(), ['DEC79', 'DEC81']);
  assert.equal(shared.inCustody, true);

  // 修订层：DEC79-R2 内容不同，差异被记录，且不替换原件层
  const revision = view.revisions.find((r) => r.declaration === 'DEC79-R2');
  assert.equal(revision.replaces, 'DEC79');
  assert.equal(revision.contentChanged, true);
  assert.equal(revision.fromContent, digest12);
  assert.equal(revision.toContent, digestClear);
  assert.ok(view.originals.some((o) => o.content === digestClear));

  // 回执按声明版本隔离：R13/R14 都属于 DEC79，DEC79-R2 没有任何回执
  const receiptsForRevision = view.obligations.filter((o) => o.declaration === 'DEC79-R2');
  assert.ok(receiptsForRevision.every((o) => o.served === false));
  const dec79 = view.obligations.filter((o) => o.declaration === 'DEC79');
  assert.deepEqual(dec79.map((o) => o.servedReceipts.join('')).sort(), ['R13', 'R14']);
});

test('逐当事人处置：补送、补领、退请说明、已收悉各归其位', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const workDir = await freshWorkDir();
  const { ledger } = await syncAll(url, workDir);
  const projection = await ledger.project();

  const a11 = buildCaseView('A11', projection, '14:55');
  const actionOf = (party, declaration) =>
    a11.obligations.find((o) => o.party === party && o.declaration === declaration).recommendation.action;

  assert.equal(actionOf('甲方', 'DEC79'), 'done');          // R13 已收悉
  assert.equal(actionOf('乙方', 'DEC79'), 'done');          // R14 晚到但确属本声明版本
  assert.equal(actionOf('甲方', 'DEC81'), 'serve');         // 同内容已获准在管，按目录授权补送
  assert.equal(actionOf('甲方', 'DEC79-R2'), 'serve');      // 修订件已在管，独立补送
  assert.equal(actionOf('乙方', 'DEC79-R2'), 'serve');

  const a12 = buildCaseView('A12', projection, '14:55');
  assert.equal(a12.obligations.length, 1);
  assert.equal(a12.obligations[0].party, '丙方');
  // 丙方不能借同内容看到 A11 的任何送阅关系
  assert.ok(a12.obligations.every((o) => o.case === 'A12'));
  const leaked = a12.originals.flatMap((o) => o.relatedDeclarations).filter((d) => d.startsWith('DEC79'));
  assert.deepEqual(leaked, []);
});

test('无有效授权且未在管的材料判定为退请说明，并区分仍可补领与已不能取到', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())));
  const workDir = await freshWorkDir();
  const { ledger } = await syncAll(url, workDir);
  const projection = await ledger.project();

  // 构造一个只有目录授权、托管端从未发布取件号的声明
  projection.declarations.set('DEC99', { case: 'A13', leg: 'AIR', declaration: 'DEC99',
    content: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', parties: ['丁方'] });
  const a13 = buildCaseView('A13', projection, '14:55');
  assert.equal(a13.obligations[0].recommendation.action, 'return_for_explanation');

  // 对照：授权仍有效但尚未取件的情形应判补领（撤去在管事实模拟未到齐）
  projection.custody.delete('12d5425c51c66635ac00ec872b8a83ed53b1a3363d577ae8c1670a1be8e4e75c');
  const a12 = buildCaseView('A12', projection, '14:55');
  assert.equal(a12.obligations[0].recommendation.action, 'retrieve');
});
