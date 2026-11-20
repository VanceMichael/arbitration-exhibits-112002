import { createHash } from 'node:crypto';

/** 对字节计算 sha256 十六进制摘要，作为内容身份，而不是文件名或取件号身份。 */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 按来源约定的列出次序拼接多个分段，得到原件原始字节。 */
export function concatPieces(buffers) {
  return Buffer.concat(buffers);
}

const TIME = /^(\d{2}):(\d{2})$/;

/** HH:mm 比较：a < b 返回 -1，相等 0，a > b 1。 */
export function compareTime(a, b) {
  const ma = TIME.exec(a);
  const mb = TIME.exec(b);
  if (!ma || !mb) throw new Error(`时刻格式应为 HH:mm：${a} / ${b}`);
  const da = Number(ma[1]) * 60 + Number(ma[2]);
  const db = Number(mb[1]) * 60 + Number(mb[2]);
  return Math.sign(da - db);
}

/** 时刻回退一分钟（用于在取件号有效期内取件），自动处理跨整点。 */
export function oneMinuteBefore(value) {
  const m = TIME.exec(value);
  if (!m) throw new Error(`时刻格式应为 HH:mm：${value}`);
  let total = Number(m[1]) * 60 + Number(m[2]) - 1;
  if (total < 0) total = 0;
  const hour = String(Math.floor(total / 60)).padStart(2, '0');
  const minute = String(total % 60).padStart(2, '0');
  return `${hour}:${minute}`;
}
