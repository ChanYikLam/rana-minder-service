/**
 * 搜索文本规范化（read-model README §6.1、DATA-DER-003）。
 *
 * 顺序固定：NFC → Unicode 大小写折叠 → 再次 NFC → 去首尾 Unicode 空白 →
 * 内部连续空白压缩为一个 U+0020。
 * 不折叠标点、简繁体、全角/半角；首版不提供拼音或首字母搜索。
 *
 * 权威说明：规范化值统一由 PostgreSQL 中显式版本化的规范化函数执行，
 * 应用侧（本类）只用于请求预览/展示排序的确定性预规范化，
 * 不得成为可信写入值；HTTP/后台只提交原始文本。
 */
export class SearchNormalizer {
  /** 规范化搜索文本（语言中立的 Unicode 大小写折叠近似） */
  normalize(input: string): string {
    const nfc1 = input.normalize('NFC');
    const folded = nfc1.toLocaleLowerCase('und');
    const nfc2 = folded.normalize('NFC');
    const trimmed = nfc2.trim();
    return trimmed.replace(/\s+/g, ' ');
  }

  /**
   * 是否为近似层候选（DATA-DER-003：近似层固定阈值 0.6 由 PostgreSQL
   * pg_trgm word_similarity 执行；不足 3 个有效字符不启用近似层）。
   */
  isApproxCandidateEnabled(input: string): boolean {
    return this.normalize(input).length >= 3;
  }
}
