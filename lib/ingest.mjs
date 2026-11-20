import { writeFile } from 'node:fs/promises';
import { concatPieces, oneMinuteBefore, sha256 } from './digest.mjs';
import { verifySeal, withdrawalImpact } from './dossier.mjs';

const SOURCE_NAMES = ['carriers', 'depot', 'service'];

/**
 * 分阶段摄入编排：
 * 按阶段 1..N 回放三个独立来源，来源记录只追加一次；
 * 对每个托管取件号在有效期内逐段领取、按序拼接并核对内容摘要；
 * 撤下事件入账时立即固化影响快照；封存记录入账时立即核验边界。
 */
export class Ingestor {
  #client;
  #ledger;
  #at;

  constructor(client, ledger, { at = null } = {}) {
    this.#client = client;
    this.#ledger = ledger;
    this.#at = at;
  }

  async run() {
    const overview = await this.#client.root();
    const summary = {
      stages: overview.stages,
      ingested: { manifest: 0, pickup: 0, withdraw: 0, receipt: 0, seal: 0 },
      custodyVerified: [], custodyFailed: [], impactSnapshots: [], sealChecks: [],
    };

    for (let stage = 1; stage <= overview.stages; stage += 1) {
      await this.#client.setStage(stage);
      for (const name of SOURCE_NAMES) {
        const records = await this.#client.listSource(name);
        for (const entry of records) {
          await this.#handleRecord(name, entry, stage, summary);
        }
      }
    }
    return summary;
  }

  async #handleRecord(name, entry, stage, summary) {
    const dedupKey = `${name}:${entry.record}`;
    const p = entry.payload;
    switch (entry.kind) {
      case 'manifest': {
        const saved = await this.#ledger.append('manifest_observed', p,
          { stage, sourceRecord: entry.record, dedupKey });
        if (saved) summary.ingested.manifest += 1;
        break;
      }
      case 'pickup': {
        const saved = await this.#ledger.append('pickup_observed', p,
          { stage, sourceRecord: entry.record, dedupKey });
        if (saved) {
          summary.ingested.pickup += 1;
          await this.#retrieveGrant(p, stage, summary);
        }
        break;
      }
      case 'withdraw': {
        const saved = await this.#ledger.append('withdraw_observed', p,
          { stage, sourceRecord: entry.record, dedupKey });
        if (saved) {
          summary.ingested.withdraw += 1;
          // 撤下事件入账的同一时刻固化影响快照，使"当时哪些关系停止"可复查
          const projection = await this.#ledger.project();
          const impact = withdrawalImpact(p.entrance, projection, p.time);
          await this.#ledger.append('withdrawal_impact', impact, { stage, sourceRecord: entry.record });
          summary.impactSnapshots.push(impact);
        }
        break;
      }
      case 'served': {
        const saved = await this.#ledger.append('receipt_observed', p,
          { stage, sourceRecord: entry.record, dedupKey });
        if (saved) summary.ingested.receipt += 1;
        break;
      }
      case 'sealed': {
        const saved = await this.#ledger.append('seal_observed', p,
          { stage, sourceRecord: entry.record, dedupKey });
        if (saved) {
          summary.ingested.seal += 1;
          const projection = await this.#ledger.project();
          const check = verifySeal(p, projection);
          await this.#ledger.append('seal_verified', check, { stage, sourceRecord: entry.record });
          summary.sealChecks.push(check);
        }
        break;
      }
      default:
        break;
    }
  }

  /** 对一个取件授权逐段领取、拼接、核摘要；任何一段失败都不得形成在管原件。 */
  async #retrieveGrant(grant, stage, summary) {
    const at = this.#at ?? oneMinuteBefore(grant.currentUntil);
    const buffers = [];
    const files = [];
    for (const piece of grant.pieces) {
      const result = await this.#client.fetchPiece(piece, {
        entrance: grant.entrance, case: grant.case, at,
      });
      await this.#ledger.append('piece_fetched', {
        entrance: grant.entrance, case: grant.case, at, piece,
        ok: result.ok, status: result.status, reason: result.reason ?? null, detail: result.detail ?? '',
      }, { stage });
      if (!result.ok) {
        await this.#ledger.append('custody_failed', {
          entrance: grant.entrance, case: grant.case, declaration: grant.declaration,
          pieces: grant.pieces, failedPiece: piece, reason: result.reason, at,
        }, { stage });
        summary.custodyFailed.push({ entrance: grant.entrance, piece, reason: result.reason });
        return;
      }
      buffers.push(result.bytes);
      files.push(piece);
    }

    // 取件号不自带摘要：内容身份由同案卷、同声明版本的目录声明提供
    const projection = await this.#ledger.project();
    const expected = projection.declarations.get(grant.declaration)?.content ?? null;
    const bytes = concatPieces(buffers);
    const digest = sha256(bytes);
    if (expected && digest !== expected) {
      // 取件成功不代表就是原卷所指内容：摘要不符只留痕，绝不入管
      await this.#ledger.append('custody_failed', {
        entrance: grant.entrance, case: grant.case, declaration: grant.declaration,
        pieces: grant.pieces, reason: 'digest_mismatch', expected, actual: digest, at,
      }, { stage });
      summary.custodyFailed.push({ entrance: grant.entrance, reason: 'digest_mismatch', actual: digest });
      return;
    }

    if (projection.custody.has(digest)) {
      // 同内容已由独立授权核验在管：登记复用事实，但不扩大本案卷/当事人阅览范围
      await this.#ledger.append('custody_reused', {
        digest, entrance: grant.entrance, case: grant.case, declaration: grant.declaration, files, at,
      }, { stage });
      summary.custodyVerified.push({ digest, entrance: grant.entrance, reused: true });
      return;
    }

    await writeFile(this.#ledger.custodyPath(digest), bytes);
    await this.#ledger.append('custody_verified', {
      digest, entrance: grant.entrance, case: grant.case, declaration: grant.declaration, files, at,
    }, { stage });
    summary.custodyVerified.push({ digest, entrance: grant.entrance, reused: false });
  }
}
