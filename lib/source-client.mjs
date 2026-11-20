/**
 * 来源客户端：只读接入承运目录、证据托管端、送阅平台三个独立来源。
 * 只负责按来源契约取数，并把 403/404 翻译为结构化结果，不做业务判定。
 */
export class SourceError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.reason = reason; // not_authorized | not_yet_available | not_found | bad_request
  }
}

export class SourceClient {
  #base;

  constructor(baseUrl) {
    this.#base = baseUrl.replace(/\/+$/, '');
  }

  async root() {
    return this.#getJson('/');
  }

  /** 切换回放阶段；阶段切换后回读根路径确认。 */
  async setStage(stage) {
    const response = await fetch(`${this.#base}/control?stage=${stage}`, { method: 'POST' });
    if (response.status !== 200) throw new SourceError(response.status, 'bad_request', `切换阶段失败：${stage}`);
    const confirmed = await this.root();
    if (confirmed.stage !== stage) {
      throw new SourceError(500, 'bad_request', `阶段未生效：期望 ${stage}，实际 ${confirmed.stage}`);
    }
    return confirmed;
  }

  /** 分页拉取某个来源在当前阶段可查的全部记录，保持到达顺序。 */
  async listSource(name, { pageLimit = 100 } = {}) {
    const records = [];
    let offset = 0;
    for (;;) {
      const page = await this.#getJson(`/source/${name}?offset=${offset}&limit=${pageLimit}`);
      records.push(...page.records);
      if (page.next === null) return records;
      offset = page.next;
    }
  }

  /**
   * 凭托管端取件号领取一个分段原件。
   * 成功返回 { ok:true, bytes }；授权/时刻/撤下/未到齐问题返回 { ok:false, reason, status }，不抛异常。
   */
  async fetchPiece(filename, { entrance, case: docket, at }) {
    const params = new URLSearchParams({ entrance, case: docket, at });
    const response = await fetch(`${this.#base}/original/${filename}?${params}`);
    if (response.status === 200) {
      return { ok: true, status: 200, bytes: Buffer.from(await response.arrayBuffer()) };
    }
    const reason = response.status === 404 ? 'not_yet_available'
      : response.status === 403 ? 'not_authorized'
      : response.status === 400 ? 'bad_request' : 'not_found';
    let detail = '';
    try { detail = (await response.json()).error ?? ''; } catch { /* 忽略无正文响应 */ }
    return { ok: false, status: response.status, reason, detail };
  }

  async #getJson(path) {
    const response = await fetch(this.#base + path);
    if (!response.ok) throw new SourceError(response.status, 'bad_request', `来源读取失败 ${path}：${response.status}`);
    return response.json();
  }
}
