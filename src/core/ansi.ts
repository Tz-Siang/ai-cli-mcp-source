/**
 * ANSI 控制序列清理。
 * 用於 PTY 輸出（agy print mode 會吐 CSI/OSC/DCS 等序列）與其他純文字輸出。
 * 1:1 還原自 dist 的 strip 邏輯（process-service.js + peek.js 用的較完整版本）。
 */

const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_STR_DCS = /\x1b[PX^_][^\x1b]*\x1b\\/g; // DCS / SOS / PM / APC
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_TWO_CHAR = /\x1b[()][AB012]|\x1b[=>78cDEHMZ]/g;
const ANSI_COMPLETE = [ANSI_OSC, ANSI_STR_DCS, ANSI_CSI, ANSI_TWO_CHAR]
  .map(pattern => new RegExp(`^(?:${pattern.source})`));
const ANSI_PREFIX = /^\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*(?:\x1b)?|[PX^_][^\x1b]*(?:\x1b)?|[()])?$/;
const ANSI_CARRY_LIMIT = 4096;

export function stripAnsi(value: unknown): string {
  return String(value ?? '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_STR_DCS, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_TWO_CHAR, '');
}

/** PTY 串流共用清理：未完成的 ESC 序列留到下一個 chunk，完整文字立即送出。 */
export function createAnsiCleaner() {
  let carry = '';
  return {
    push(chunk: string): string {
      const text = carry + chunk;
      carry = '';
      const output: string[] = [];
      let cursor = 0;
      for (let at = text.indexOf('\x1b'); at !== -1; at = text.indexOf('\x1b', cursor)) {
        output.push(text.slice(cursor, at));
        const tail = text.slice(at);
        const complete = ANSI_COMPLETE.map(pattern => tail.match(pattern)).find(Boolean);
        if (complete) { cursor = at + complete[0].length; continue; }
        if (ANSI_PREFIX.test(tail)) {
          // 有界 carry：每次最多重掃 4096 字元；超長殘缺序列放棄，不扣住後續 chunk。
          if (tail.length <= ANSI_CARRY_LIMIT) carry = tail;
          return output.join('');
        }
        // 格式錯誤只丟掉這個 ESC，後面的文字／新序列仍須立即處理。
        cursor = at + 1;
      }
      output.push(text.slice(cursor));
      return output.join('');
    },
    flush(): string { carry = ''; return ''; }, // 未完成的控制序列不得洩漏成亂碼。
  };
}
