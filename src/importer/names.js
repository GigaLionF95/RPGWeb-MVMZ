// Archive member names: UTF-8 when flagged or valid, else Shift-JIS (common
// for Japanese RPG Maker releases), else CP437/latin1.
const utf8 = new TextDecoder('utf-8', { fatal: true });
let sjis = null;
try { sjis = new TextDecoder('shift_jis', { fatal: true }); } catch { /* small-icu build */ }

export function decodeName(buf, utf8Flag) {
  if (utf8Flag) return buf.toString('utf8');
  let ascii = true;
  for (const b of buf) if (b >= 0x80) { ascii = false; break; }
  if (ascii) return buf.toString('latin1');
  try { return utf8.decode(buf); } catch { /* not utf-8 */ }
  if (sjis) { try { return sjis.decode(buf); } catch { /* not sjis */ } }
  return buf.toString('latin1');
}
