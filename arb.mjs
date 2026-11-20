#!/usr/bin/env node
import { resolve } from 'node:path';
import { SourceClient } from './lib/source-client.mjs';
import { Ledger } from './lib/ledger.mjs';
import { Ingestor } from './lib/ingest.mjs';
import { buildCaseView, withdrawalImpact } from './lib/dossier.mjs';
import { compareTime } from './lib/digest.mjs';

const DEFAULT_SOURCE = process.env.SOURCE_URL ?? 'http://127.0.0.1:4100';
const DEFAULT_WORK = process.env.WORK_DIR ?? './work-data';

function parseArgs(argv) {
  const args = { _: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') args.json = true;
    else if (token.startsWith('--')) args[token.slice(2)] = argv[++i];
    else args._.push(token);
  }
  return args;
}

const ACTION_LABEL = {
  retrieve: '补领',
  serve: '补送',
  return_for_explanation: '退请说明',
  done: '已收悉',
};

function print(value, asJson) {
  process.stdout.write(asJson ? JSON.stringify(value, null, 2) + '\n' : value);
}

async function loadLedger(workDir) {
  const ledger = new Ledger(resolve(workDir));
  await ledger.open();
  return ledger;
}

function latestReferenceTime(projection) {
  const times = [...projection.entrances.values()].map((entrance) => entrance.withdrawnAt).filter(Boolean);
  return times.sort(compareTime).at(-1) ?? '14:55';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, ...rest] = args._;
  const workDir = args.work ?? DEFAULT_WORK;
  const asJson = args.json;

  switch (command) {
    case 'sync': {
      const client = new SourceClient(args.source ?? DEFAULT_SOURCE);
      const ledger = await loadLedger(workDir);
      const ingestor = new Ingestor(client, ledger, { at: args.at ?? null });
      const summary = await ingestor.run();
      if (asJson) print(summary, true);
      else {
        print(`摄入完成（${summary.stages} 个回放阶段）\n`, false);
        print(`来源记录：清单 ${summary.ingested.manifest}、取件 ${summary.ingested.pickup}、` +
          `撤下 ${summary.ingested.withdraw}、回执 ${summary.ingested.receipt}、封存 ${summary.ingested.seal}\n`, false);
        for (const item of summary.custodyVerified) {
          print(`  ${item.reused ? '复用在管' : '核验入管'} ${item.digest.slice(0, 12)}… 经入口 ${item.entrance}\n`, false);
        }
        for (const item of summary.custodyFailed) {
          print(`  未入管 入口 ${item.entrance} 分段 ${item.piece ?? '-'} 原因 ${item.reason}\n`, false);
        }
      }
      break;
    }

    case 'cases': {
      const ledger = await loadLedger(workDir);
      const projection = await ledger.project();
      const caseIds = [...new Set([...projection.declarations.values()].map((d) => d.case))].sort();
      print(asJson ? caseIds : caseIds.map((id) => id).join('\n') + '\n', asJson);
      break;
    }

    case 'case': {
      const caseId = rest[0];
      if (!caseId) throw new Error('用法：case <案卷号>');
      const ledger = await loadLedger(workDir);
      const projection = await ledger.project();
      const at = args.at ?? latestReferenceTime(projection);
      if (![...projection.declarations.values()].some((d) => d.case === caseId)) {
        throw new Error(`台账中没有案卷 ${caseId}，先执行 sync 或检查案卷号`);
      }
      const view = buildCaseView(caseId, projection, at);
      if (asJson) print(view, true);
      else printCaseView(view);
      break;
    }

    case 'impact': {
      const entranceId = rest[0];
      if (!entranceId) throw new Error('用法：impact <取件入口>');
      const ledger = await loadLedger(workDir);
      const projection = await ledger.project();
      if (!projection.entrances.has(entranceId)) {
        throw new Error(`台账中没有取件入口 ${entranceId}，先执行 sync 或检查入口号`);
      }
      const at = args.at ?? latestReferenceTime(projection);
      const historical = projection.impactSnapshots.filter((snapshot) => snapshot.entrance === entranceId);
      const current = withdrawalImpact(entranceId, projection, at);
      if (asJson) print({ historicalSnapshots: historical, current }, true);
      else printImpact(entranceId, historical, current);
      break;
    }

    case 'seals': {
      const ledger = await loadLedger(workDir);
      const projection = await ledger.project();
      if (asJson) print(projection.seals, true);
      else printSeals(projection.seals);
      break;
    }

    case 'events': {
      const ledger = await loadLedger(workDir);
      const events = await ledger.events();
      if (asJson) print(events, true);
      else {
        for (const event of events) {
          print(`${String(event.seq).padStart(3, '0')} 阶段${event.stage} ${event.type}` +
            `${event.sourceRecord ? ` [${event.sourceRecord}]` : ''}\n`, false);
        }
      }
      break;
    }

    default:
      print('用法：arb.mjs <sync|cases|case|impact|seals|events> [参数] [--json]\n', false);
      process.exitCode = 1;
  }
}

function printCaseView(view) {
  print(`案卷 ${view.case}（参考时刻 ${view.at}）\n`, false);
  print('\n一、原件层（按内容摘要，不以文件名或取件号为身份）\n', false);
  for (const original of view.originals) {
    print(`  摘要 ${original.content.slice(0, 16)}… ${original.inCustody ? '已核验在管' : '未在管'}\n`, false);
    if (original.custodiedVia) {
      print(`    在管来源：入口 ${original.custodiedVia.entrance} / 声明 ${original.custodiedVia.declaration} / 分段 ${original.custodiedVia.files.join('+')}\n`, false);
      if (original.custodiedVia.note) print(`    说明：${original.custodiedVia.note}\n`, false);
    }
    print(`    关联声明：${original.relatedDeclarations.join('、') || '无'}\n`, false);
    if (original.otherCaseAuthorizations.length) {
      print(`    他案独立授权（隔离，不扩大本案阅览）：${original.otherCaseAuthorizations.map((a) => `${a.case}/${a.entrance}`).join('、')}\n`, false);
    }
  }
  print('\n二、关联声明层（运程、交接声明、授权当事人）\n', false);
  for (const declaration of view.declarations) {
    const kind = declaration.kind === 'revision' ? '后续修订' : '交接声明';
    print(`  [${kind}] ${declaration.declaration}（${declaration.leg}）当事人：${declaration.parties.join('、')}\n`, false);
    if (declaration.replaces) print(`    修订自 ${declaration.replaces}，独立版本，不替换原卷\n`, false);
    for (const grant of declaration.grants) {
      const status = grant.withdrawnAt ? `已于 ${grant.withdrawnAt} 撤下` : grant.usableNow ? '有效' : '已过有效期';
      print(`    入口 ${grant.entrance}：${grant.pieces.join('+')}（${status}，有效期至 ${grant.currentUntil}）\n`, false);
    }
  }
  if (view.revisions.length) {
    print('\n三、后续修订与差异（独立送阅，回执不得互算）\n', false);
    for (const revision of view.revisions) {
      print(`  ${revision.declaration} → 修订 ${revision.replaces}：内容${revision.contentChanged ? '不同' : '相同'}\n`, false);
      print(`    ${revision.fromContent?.slice(0, 12)}… → ${revision.toContent.slice(0, 12)}…\n`, false);
    }
  }
  print('\n四、逐当事人送阅关系与处置\n', false);
  for (const obligation of view.obligations) {
    const receipt = obligation.served ? `回执 ${obligation.servedReceipts.join('、')}` : '未收悉';
    print(`  ${obligation.party} / ${obligation.declaration}（${obligation.leg}）：${receipt}` +
      ` → 【${ACTION_LABEL[obligation.recommendation.action]}】${obligation.recommendation.reason}\n`, false);
  }
  if (view.seals.length) {
    print('\n五、封存卷宗\n', false);
    for (const seal of view.seals) printSealLine(seal);
  }
}

function printImpact(entranceId, historical, current) {
  print(`取件入口 ${entranceId} 撤下影响\n`, false);
  if (historical.length) {
    print('\n撤下入账时固化的历史快照（可复查）\n', false);
    for (const snapshot of historical) printImpactBody(snapshot);
  } else {
    print('\n（无撤下事件，或该入口未被撤下）\n', false);
  }
  print('\n按当前参考时刻重算\n', false);
  printImpactBody(current);
}

function printImpactBody(impact) {
  print(`  作用域：案卷 ${impact.scope.case} / 声明 ${impact.scope.declaration}，撤下时刻 ${impact.withdrawnAt ?? '未撤下'}\n`, false);
  print(`  停止的待送关系（${impact.stopped.length}）：\n`, false);
  for (const item of impact.stopped) print(`    - ${item.party}/${item.declaration}：${item.note}\n`, false);
  print(`  仅历史可查的已交材料（${impact.historyOnly.length}）：\n`, false);
  for (const item of impact.historyOnly) print(`    - ${item.party}/${item.declaration} 回执 ${item.receipts.join('、')}\n`, false);
  print(`  同内容的他案独立授权（${impact.independent.length}）：\n`, false);
  for (const item of impact.independent) print(`    - ${item.case}/${item.declaration} 经 ${item.entrance}：${item.note}\n`, false);
}

function printSeals(seals) {
  if (!seals.length) print('（暂无封存记录）\n', false);
  for (const seal of seals) printSealLine(seal);
}

function printSealLine(seal) {
  print(`卷宗 ${seal.volume}（案卷 ${seal.case}，封存于 ${seal.time}）\n`, false);
  const verification = seal.verification;
  if (!verification) {
    print('  尚未核验\n', false);
    return;
  }
  print(`  核验：${verification.valid ? '边界一致，可复查' : '边界不一致'}\n`, false);
  for (const known of verification.known) {
    print(`  已收悉 ${known.receipt}（${known.party}/${known.declaration}）：${known.exists ? '真实' : '台账中不存在'}\n`, false);
  }
  for (const outstanding of verification.outstanding) {
    const later = outstanding.laterReceipts.length ? `，后补回执 ${outstanding.laterReceipts.join('、')}（封存边界不变）` : '';
    print(`  缺件 ${outstanding.token}：封存时${outstanding.stillOutstanding ? '确未收悉' : '已有回执，标记有误'}${later}\n`, false);
  }
  for (const item of verification.outOfScope) {
    print(`  卷外关系 ${item.party}/${item.declaration}：${item.served ? '已收悉' : '未收悉'}，不并入本卷缺件边界\n`, false);
  }
}

main().catch((error) => {
  process.stderr.write(`错误：${error.message}\n`);
  process.exitCode = 1;
});

// 输出经 head 等管道提前关闭时安静退出，不抛未处理异常
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
