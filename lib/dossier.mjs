import { compareTime } from './digest.mjs';

/**
 * 纯领域逻辑：在台账投影之上构建案卷视图、送阅义务、撤下影响和封存核验。
 * 这里不直接访问网络或文件系统，便于逐条单元测试。
 */

/** 清单声明的版本链：被哪个声明修订、它修订了谁。 */
function buildVersionChain(declarations) {
  const revisionOf = new Map(); // 原声明 -> 修订声明
  const revisedFrom = new Map(); // 修订声明 -> 原声明
  for (const [id, declaration] of declarations) {
    if (declaration.replaces) {
      revisionOf.set(declaration.replaces, id);
      revisedFrom.set(id, declaration.replaces);
    }
  }
  return { revisionOf, revisedFrom };
}

/** 案卷中每个当事人 x 声明版本的应送阅关系（来自目录授权的 parties）。 */
export function buildObligations(projection) {
  const { declarations, entrances, receipts, custody } = projection;
  const obligations = [];

  for (const [declarationId, declaration] of declarations) {
    for (const party of declaration.parties) {
      const key = `${declaration.case}|${party}|${declarationId}`;
      const served = receipts.get(key) ?? [];
      const grantEntrances = [...entrances.values()].filter(
        (entrance) => entrance.case === declaration.case && entrance.declaration === declarationId,
      );
      const inCustody = custody.has(declaration.content);
      obligations.push({
        case: declaration.case,
        party,
        declaration: declarationId,
        leg: declaration.leg,
        content: declaration.content,
        servedReceipts: served.map((receipt) => receipt.receipt),
        served: served.length > 0,
        contentMatched: served.every((receipt) => receipt.content === declaration.content),
        grants: grantEntrances.map((entrance) => entrance.entrance),
        inCustody,
      });
    }
  }
  return obligations;
}

/**
 * 判定一个授权入口在给定本地时刻是否仍可凭以取件：
 * 已撤下（撤下时刻 <= at）、或时刻晚于取件号有效期，都不可再取。
 */
export function entranceUsableAt(entrance, at) {
  if (entrance.withdrawnAt && compareTime(entrance.withdrawnAt, at) <= 0) return false;
  if (at && compareTime(at, entrance.currentUntil) >= 0) return false;
  return true;
}

/**
 * 对一条送阅关系给出处置建议：
 * - serve（补送）：原件已在获准保管范围内且当事人尚未收悉
 * - retrieve（补领）：授权仍有效但原件尚未到齐
 * - return_for_explanation（退请说明）：授权链断裂（无有效取件号、且无内容核验记录）
 * - done（已收悉）：已有内容一致的回执
 * 内容相同只允许复用本案已获准保管的原件，不跨案卷、不跨当事人扩权。
 */
export function recommendAction(obligation, projection, at) {
  if (obligation.served) {
    return obligation.contentMatched
      ? { action: 'done', reason: '已有内容一致的收悉回执' }
      : { action: 'return_for_explanation', reason: '回执内容摘要与声明不一致，需退请说明' };
  }
  const usableGrants = obligation.grants
    .map((entranceId) => projection.entrances.get(entranceId))
    .filter((entrance) => entrance && entranceUsableAt(entrance, at));

  if (obligation.inCustody) {
    return { action: 'serve', reason: '原件已核验在管，可按授权范围补送' };
  }
  if (usableGrants.length > 0) {
    return { action: 'retrieve', reason: `授权入口仍有效（${usableGrants.map((e) => e.entrance).join('、')}），可补领原件` };
  }
  return { action: 'return_for_explanation', reason: '无有效取件号且原件未核验在管，授权链断裂，退请说明' };
}

/**
 * 撤下影响分析（撤下事件入账时的历史快照所需输入）。
 * 作用域严格限定为该入口所属案卷与声明：
 * 1. stopped：撤下时仍待送、且只能经该入口取件的送阅关系（补领通道停止）；
 * 2. historyOnly：撤下前已交材料，此后只能查历史，不能再凭此入口重取；
 * 3. independent：其他案卷/入口对同一内容仍有的独立授权；
 * 4. sealedAtWithdraw：撤下发生时已封存、边界可复查的卷宗。
 */
export function withdrawalImpact(entranceId, projection, at) {
  const entrance = projection.entrances.get(entranceId);
  if (!entrance) throw new Error(`未知取件入口：${entranceId}`);

  const obligations = buildObligations(projection);
  const stopped = [];
  const historyOnly = [];

  for (const obligation of obligations) {
    if (obligation.case !== entrance.case || obligation.declaration !== entrance.declaration) continue;
    if (obligation.served) {
      historyOnly.push({
        case: obligation.case,
        party: obligation.party,
        declaration: obligation.declaration,
        receipts: obligation.servedReceipts,
        note: '已交材料此后仅历史可查，该入口不得再用于重取或扩权',
      });
      continue;
    }
    const otherGrants = obligation.grants.filter((id) => id !== entranceId)
      .map((id) => projection.entrances.get(id))
      .filter((other) => other && entranceUsableAt(other, at));
    if (otherGrants.length === 0) {
      stopped.push({
        case: obligation.case,
        party: obligation.party,
        declaration: obligation.declaration,
        content: obligation.content,
        note: '待送关系的补领通道随入口撤下而停止',
      });
    }
  }

  // 同内容在其他案卷仍有独立授权：仅作事实登记，绝不据此扩大本案阅览范围
  const independent = [...projection.entrances.values()]
    .filter((other) => other.entrance !== entranceId &&
      other.withdrawnAt === null &&
      projection.declarations.get(other.declaration)?.content ===
        projection.declarations.get(entrance.declaration)?.content)
    .map((other) => ({
      entrance: other.entrance,
      case: other.case,
      declaration: other.declaration,
      note: '同内容的独立授权，授权范围彼此隔离',
    }));

  return {
    entrance: entranceId,
    scope: { case: entrance.case, declaration: entrance.declaration },
    withdrawnAt: entrance.withdrawnAt,
    at,
    stopped,
    historyOnly,
    independent,
  };
}

/**
 * 封存核验：封卷时 known 回执必须真实存在且属于该案卷；
 * outstanding 必须确实没有对应收悉记录。卷宗范围之外的待送关系单独标出，不混入缺件边界。
 */
export function verifySeal(seal, projection) {
  const knownChecks = seal.known.map((receiptId) => {
    const found = [...projection.receipts.values()].flat()
      .find((receipt) => receipt.receipt === receiptId && receipt.case === seal.case);
    return {
      receipt: receiptId,
      exists: Boolean(found),
      party: found?.party ?? null,
      declaration: found?.declaration ?? null,
      content: found?.content ?? null,
    };
  });

  const outstandingChecks = seal.outstanding.map((token) => {
    const [party, declaration] = token.split('/');
    const key = `${seal.case}|${party}|${declaration}`;
    const served = projection.receipts.get(key) ?? [];
    return { token, party, declaration, stillOutstanding: served.length === 0, laterReceipts: served.map((r) => r.receipt) };
  });

  const scopeDeclarations = new Set([
    ...knownChecks.filter((check) => check.declaration).map((check) => check.declaration),
    ...outstandingChecks.map((check) => check.declaration),
  ]);
  const outOfScope = buildObligations(projection)
    .filter((obligation) => obligation.case === seal.case && !scopeDeclarations.has(obligation.declaration))
    .map((obligation) => ({ party: obligation.party, declaration: obligation.declaration, served: obligation.served }));

  const valid = knownChecks.every((check) => check.exists) &&
    outstandingChecks.every((check) => check.stillOutstanding);

  return {
    volume: seal.volume,
    case: seal.case,
    sealedTime: seal.time,
    valid,
    known: knownChecks,
    outstanding: outstandingChecks,
    outOfScope,
    note: valid ? '封存边界与台账一致，可复查' : '封存边界与台账不一致，需更正后重封',
  };
}

/**
 * 组装案卷视图，显式区分三层：
 * - originals：按内容摘要标识的原件（在管状态、经哪个入口核验、拼接分段）
 * - declarations：关联声明（运程、交接声明、版本链、授权当事人）
 * - revisions：后续修订（不同内容、独立送阅、差异记录）
 */
export function buildCaseView(caseId, projection, at) {
  const { revisionOf, revisedFrom } = buildVersionChain(projection.declarations);
  const caseDeclarations = [...projection.declarations.values()].filter((d) => d.case === caseId);

  const declarationViews = caseDeclarations.map((declaration) => {
    const grants = [...projection.entrances.values()]
      .filter((entrance) => entrance.case === caseId && entrance.declaration === declaration.declaration)
      .map((entrance) => ({
        entrance: entrance.entrance,
        pieces: entrance.pieces,
        currentUntil: entrance.currentUntil,
        withdrawnAt: entrance.withdrawnAt,
        usableNow: entranceUsableAt(entrance, at),
      }));
    return {
      kind: revisedFrom.has(declaration.declaration) ? 'revision' : 'declaration',
      declaration: declaration.declaration,
      leg: declaration.leg,
      replaces: declaration.replaces ?? null,
      revisedBy: revisionOf.get(declaration.declaration) ?? null,
      content: declaration.content,
      parties: declaration.parties,
      grants,
      inCustody: projection.custody.has(declaration.content),
    };
  });

  const contentDigests = new Set(caseDeclarations.map((d) => d.content));
  const originalViews = [...contentDigests].map((digest) => {
    const custodied = projection.custody.get(digest) ?? null;
    const relatedDeclarations = caseDeclarations.filter((d) => d.content === digest).map((d) => d.declaration);
    // 同内容可能先经他案入口核验在管；展示在管来源时优先本案授权，他案入口只作复用溯源
    const sameCaseGrant = [...projection.entrances.values()]
      .filter((entrance) => entrance.case === caseId &&
        projection.declarations.get(entrance.declaration)?.content === digest)
      .at(-1);
    const custodiedVia = !custodied ? null : sameCaseGrant ? {
      entrance: sameCaseGrant.entrance,
      declaration: sameCaseGrant.declaration,
      files: sameCaseGrant.pieces,
      note: `原件先经 ${custodied.entrance} 核验在管，本案凭独立授权复用，不扩大阅览范围`,
    } : {
      entrance: custodied.entrance,
      declaration: custodied.declaration,
      files: custodied.files,
      note: custodied.case === caseId ? null : '原件经他案授权核验在管，本案阅览仍以本案授权为限',
    };
    return {
      content: digest,
      layer: 'original',
      inCustody: Boolean(custodied),
      custodiedVia,
      relatedDeclarations,
      // 同内容在其他案卷的授权只是隔离事实，不进入本案可阅览范围
      otherCaseAuthorizations: [...projection.entrances.values()]
        .filter((entrance) => entrance.case !== caseId &&
          projection.declarations.get(entrance.declaration)?.content === digest)
        .map((entrance) => ({ case: entrance.case, entrance: entrance.entrance })),
    };
  });

  const revisionViews = declarationViews.filter((view) => view.kind === 'revision').map((view) => {
    const original = caseDeclarations.find((d) => d.declaration === view.replaces);
    return {
      declaration: view.declaration,
      replaces: view.replaces,
      contentChanged: original ? original.content !== view.content : null,
      fromContent: original?.content ?? null,
      toContent: view.content,
      note: '新版证据有独立送阅与差异记录，不替换原卷所指内容',
    };
  });

  const obligations = buildObligations(projection)
    .filter((obligation) => obligation.case === caseId)
    .map((obligation) => ({ ...obligation, recommendation: recommendAction(obligation, projection, at) }));

  return {
    case: caseId,
    at,
    originals: originalViews,
    declarations: declarationViews,
    revisions: revisionViews,
    obligations,
    seals: projection.seals.filter((seal) => seal.case === caseId),
  };
}
