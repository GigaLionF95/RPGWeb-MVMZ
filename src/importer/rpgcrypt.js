// RPG Maker MV/MZ asset "encryption": 16-byte fake header + first 16 bytes
// XOR'ed with System.json encryptionKey.
export const HEADER = Buffer.from('5250474d560000000003010000000000', 'hex');

export const ENCRYPTED_EXT = {
  mv: { '.png': '.rpgmvp', '.ogg': '.rpgmvo', '.m4a': '.rpgmvm', '.wav': '.rpgmvw' },
  mz: { '.png': '.png_', '.ogg': '.ogg_', '.m4a': '.m4a_', '.wav': '.wav_' },
};

function keyBytes(hex) {
  const k = Buffer.from(String(hex || ''), 'hex');
  if (k.length !== 16) throw new Error('bad encryptionKey');
  return k;
}

export function decrypt(buf, keyHex) {
  const key = keyBytes(keyHex);
  const body = Buffer.from(buf.subarray(16));
  for (let i = 0; i < 16 && i < body.length; i++) body[i] ^= key[i];
  return body;
}

export function encrypt(buf, keyHex) {
  const key = keyBytes(keyHex);
  const body = Buffer.from(buf);
  for (let i = 0; i < 16 && i < body.length; i++) body[i] ^= key[i];
  return Buffer.concat([HEADER, body]);
}
