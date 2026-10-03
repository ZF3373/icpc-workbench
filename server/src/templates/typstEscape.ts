/** Typst 字符串字面量转义：用户内容只作为 text/raw 的字符串参数，不参与 Typst 标记解析。 */
export function typstString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (ch) =>
      `\\u{${ch.charCodeAt(0).toString(16)}}`,
    );
  return `"${escaped}"`;
}
