import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 只追加的案卷台账（append-only ledger）。
 * 所有来源事实和本地核验结论都以事件落盘，永不修改、永不删除；
 * 撤下、补领、修订都通过新事件表达，封存时的历史状态因此可随时复查。
 */
export class Ledger {
  #dir;
  #file;
  #seq = 0;
  #seen = new Set();

  constructor(workDir) {
    this.#dir = workDir;
    this.#file = join(workDir, 'ledger.jsonl');
  }

  async open() {
    await mkdir(join(this.#dir, 'custody'), { recursive: true });
    if (!existsSync(this.#file)) return;
    const lines = (await readFile(this.#file, 'utf8')).split('\n').filter(Boolean);
    for (const line of lines) {
      const event = JSON.parse(line);
      this.#seq = Math.max(this.#seq, event.seq);
      if (event.dedupKey) this.#seen.add(event.dedupKey);
    }
  }

  /**
   * 追加事件。带 dedupKey 的来源事实重复出现时跳过（同一来源记录只入账一次）；
   * 取件尝试等过程事件不给 dedupKey，每次都留痕。
   */
  async append(type, payload, { stage, sourceRecord = null, dedupKey = null, now = new Date() } = {}) {
    if (dedupKey && this.#seen.has(dedupKey)) return null;
    const event = {
      eventId: randomUUID(),
      seq: (this.#seq += 1),
      at: now.toISOString(),
      stage,
      sourceRecord,
      type,
      payload,
    };
    if (dedupKey) event.dedupKey = dedupKey;
    await appendFile(this.#file, JSON.stringify(event) + '\n', 'utf8');
    if (dedupKey) this.#seen.add(dedupKey);
    return event;
  }

  async events() {
    if (!existsSync(this.#file)) return [];
    return (await readFile(this.#file, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  }

  custodyPath(digest) {
    return join(this.#dir, 'custody', `${digest}.bin`);
  }

  /** 重放全部事件，构建当前投影。纯计算，不改变台账。 */
  async project() {
    const events = await this.events();
    const declarations = new Map(); // declaration -> 清单声明（含版本链）
    const entrances = new Map();    // entrance -> { grant, withdrawnAt, withdrawRecord }
    const receipts = new Map();     // 案卷|当事人|声明版本 -> 回执列表
    const seals = [];
    const custody = new Map();      // 内容摘要 -> 保管条目
    const fetchAttempts = [];
    const impactSnapshots = [];
    const reuseRecords = [];
    const sealChecks = new Map();   // volume -> 封存核验结果
    const stagesSeen = new Set();

    for (const event of events) {
      stagesSeen.add(event.stage);
      const p = event.payload;
      switch (event.type) {
        case 'manifest_observed': {
          declarations.set(p.declaration, { ...p, observedStage: event.stage, record: event.sourceRecord });
          break;
        }
        case 'pickup_observed': {
          entrances.set(p.entrance, {
            entrance: p.entrance,
            case: p.case,
            declaration: p.declaration,
            pieces: [...p.pieces],
            currentUntil: p.currentUntil,
            observedStage: event.stage,
            record: event.sourceRecord,
            withdrawnAt: null,
          });
          break;
        }
        case 'withdraw_observed': {
          const entrance = entrances.get(p.entrance);
          if (entrance) {
            entrance.withdrawnAt = p.time;
            entrance.withdrawRecord = event.sourceRecord;
            entrance.withdrawStage = event.stage;
          }
          break;
        }
        case 'receipt_observed': {
          const key = `${p.case}|${p.party}|${p.declaration}`;
          const list = receipts.get(key) ?? [];
          list.push({ ...p, observedStage: event.stage, record: event.sourceRecord });
          receipts.set(key, list);
          break;
        }        case 'seal_observed': {
          seals.push({ ...p, observedStage: event.stage, record: event.sourceRecord });
          break;
        }
        case 'piece_fetched': {
          fetchAttempts.push({ ...p, stage: event.stage, eventSeq: event.seq });
          break;
        }
        case 'custody_verified': {
          custody.set(p.digest, {
            digest: p.digest,
            files: p.files,
            entrance: p.entrance,
            case: p.case,
            declaration: p.declaration,
            record: event.sourceRecord,
            verifiedStage: event.stage,
          });
          break;
        }
        case 'custody_failed': {
          // 失败只留痕，不形成可复用的保管条目
          break;
        }
        case 'custody_reused': {
          reuseRecords.push({ ...p, stage: event.stage, eventSeq: event.seq });
          break;
        }
        case 'withdrawal_impact': {
          impactSnapshots.push({ ...p, stage: event.stage, eventSeq: event.seq });
          break;
        }
        case 'seal_verified': {
          sealChecks.set(p.volume, p);
          break;
        }
        default:
          break;
      }
    }

    return {
      events,
      declarations,
      entrances,
      receipts,
      seals: seals.map((seal) => ({ ...seal, verification: sealChecks.get(seal.volume) ?? null })),
      custody,
      fetchAttempts,
      impactSnapshots,
      reuseRecords,
      maxStage: stagesSeen.size ? Math.max(...stagesSeen) : 0,
    };
  }
}
