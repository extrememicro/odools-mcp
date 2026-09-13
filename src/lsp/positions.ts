export function codePointColumnToUtf16(line: string, oneBasedColumn: number): number {
  if (!Number.isInteger(oneBasedColumn) || oneBasedColumn < 1) throw new Error("column must be a positive one-based integer");
  const points = Array.from(line);
  const index = oneBasedColumn - 1;
  if (index > points.length) throw new Error("column exceeds line length");
  return points.slice(0, index).join("").length;
}

export function utf16ColumnToCodePoint(line: string, utf16Column: number): number {
  if (!Number.isInteger(utf16Column) || utf16Column < 0 || utf16Column > line.length) throw new Error("invalid UTF-16 column");
  const prefix = line.slice(0, utf16Column);
  if (prefix.length > 0) {
    const last = prefix.charCodeAt(prefix.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) throw new Error("UTF-16 position splits a surrogate pair");
  }
  return Array.from(prefix).length + 1;
}
