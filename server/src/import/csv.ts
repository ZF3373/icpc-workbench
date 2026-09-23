/**
 * 极简 RFC4180 风格 CSV 解析：支持双引号包裹字段、引号内逗号/换行/转义引号。
 * 返回二维字符串数组；首行不特殊处理（由调用方按表头消费）。
 * 起手剥离 UTF-8 BOM：Excel 的「CSV UTF-8」导出必带 \uFEFF，不剥则表头首列变成
 * \uFEFFproblemKey，整份文件被表头校验拒绝——手动导入最常见的输入格式。
 */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === ',') {
      pushField();
      i += 1;
    } else if (c === '\n') {
      pushRow();
      i += 1;
    } else if (c === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}
