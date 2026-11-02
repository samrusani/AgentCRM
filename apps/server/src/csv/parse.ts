import { CsvError } from 'csv-parse';
import { parse } from 'csv-parse/sync';
import { validationError } from '../errors.js';

export const maxCsvBytes = 10 * 1024 * 1024;
export const maxCsvRows = 20_000;
const maxCsvColumns = 200;

export type CsvDelimiter = ',' | ';' | '\t';
const delimiters: readonly CsvDelimiter[] = [',', ';', '\t'];

export interface ParsedCsv {
  headers: string[];
  delimiter: CsvDelimiter;
  // Each row is keyed by header, with the cell text exactly as the file has it.
  rows: Record<string, string>[];
}

export const notUtf8Message = 'The file is not valid UTF-8 text. Save it as UTF-8 and try again.';

// Invalid bytes decode to U+FFFD, so a Latin-1 or UTF-16 file shows up as replacement characters.
// Staging that would silently store corrupted names, so it is refused instead.
export function assertUtf8Text(content: string): void {
  if (content.includes('\uFFFD')) throw validationError(notUtf8Message);
}

export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

// Counts each candidate delimiter in the first line, ignoring anything inside quotes. Comma wins ties.
export function sniffDelimiter(content: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(delimiters.map((delimiter) => [delimiter, 0]));
  let inQuotes = false;
  for (const character of content) {
    if (character === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (character === '\n' || character === '\r') break;
      if (character === ',' || character === ';' || character === '\t') {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }
  }
  let best: CsvDelimiter = ',';
  let bestCount = 0;
  for (const delimiter of delimiters) {
    const count = counts.get(delimiter) ?? 0;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

// Blank header cells become column_<n>. Repeated names are rejected, because rows are keyed by header.
function cleanHeaders(cells: string[]): string[] {
  const seen = new Set<string>();
  return cells.map((cell, index) => {
    const header = cell.trim() === '' ? `column_${index + 1}` : cell.trim();
    if (seen.has(header)) {
      throw validationError(`The column name "${header}" appears more than once in the header row. Give each column a different name.`);
    }
    seen.add(header);
    return header;
  });
}

export function parseCsv(rawContent: string): ParsedCsv {
  if (Buffer.byteLength(rawContent, 'utf8') > maxCsvBytes) {
    throw validationError(`The file is larger than ${maxCsvBytes / (1024 * 1024)} MB. Split it into smaller files.`);
  }
  const content = stripBom(rawContent);
  if (content.trim() === '') throw validationError('The file is empty. It needs a header row and at least one data row.');
  const delimiter = sniffDelimiter(content);

  let records: string[][];
  try {
    records = parse(content, {
      delimiter,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      // One header record, the allowed rows, and one more so a file over the cap is detected.
      to: maxCsvRows + 2,
    });
  } catch (error) {
    const reason = error instanceof CsvError ? error.message : 'The file could not be read.';
    throw validationError(`The file is not valid CSV: ${reason}`);
  }

  const headerRecord = records[0];
  if (!headerRecord || headerRecord.every((cell) => cell.trim() === '')) {
    throw validationError('The first row must contain column names.');
  }
  if (headerRecord.length > maxCsvColumns) {
    throw validationError(`The file has more than ${maxCsvColumns} columns.`);
  }
  const dataRecords = records.slice(1);
  if (dataRecords.length > maxCsvRows) {
    throw validationError(`The file has more than ${maxCsvRows.toLocaleString('en-US')} data rows. Split it into smaller files.`);
  }

  const headers = cleanHeaders(headerRecord);
  const rows = dataRecords.map((record, index) => {
    const extra = record.slice(headers.length);
    if (extra.some((cell) => cell.trim() !== '')) {
      throw validationError(`Row ${index + 1} has more values than the ${headers.length} columns in the header row.`);
    }
    const row: Record<string, string> = {};
    headers.forEach((header, column) => {
      row[header] = record[column] ?? '';
    });
    return row;
  });
  return { headers, delimiter, rows };
}
