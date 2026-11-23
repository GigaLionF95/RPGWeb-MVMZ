// Limits for unpacking untrusted archives: total bytes written and file count,
// shared by every extractor of one import (outer archive + nested packages),
// so a zip/tar/brotli bomb fails fast instead of filling the disk.

const GB = 1024 ** 3;

export class UnpackBudget {
  constructor({ maxBytes = 20 * GB, maxFiles = 200000 } = {}) {
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.bytes = 0;
    this.files = 0;
  }

  /** Account one more file. */
  file() {
    if (++this.files > this.maxFiles) {
      throw new Error(`the archive has more than ${this.maxFiles} files (limit: RPGM_MAX_FILES)`);
    }
  }

  /** Account n more bytes written to disk. */
  add(n) {
    this.bytes += n;
    if (this.bytes > this.maxBytes) {
      throw new Error(`the archive unpacks to more than ${+(this.maxBytes / GB).toFixed(2)} GB (limit: RPGM_MAX_UNPACKED_GB)`);
    }
  }

  /** Fail early on sizes an archive declares up front. */
  check(declaredBytes, declaredFiles = 0) {
    if (this.bytes + declaredBytes > this.maxBytes) this.add(declaredBytes);
    if (this.files + declaredFiles > this.maxFiles) { this.files += declaredFiles; this.file(); }
  }
}

/** Small metadata blobs (configs, headers) are read whole: cap them. */
export const MAX_META_BYTES = 16 * 1024 * 1024;
