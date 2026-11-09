import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { useCsvPreview, useStageCsv } from '../api/hooks';
import type { CsvMapping, CsvMappingTarget, CsvPreview, Run } from '../api/types';
import { Sheet, errorMessage } from '../components/common';
import { SheetSection } from '../components/record';
import { formatCount } from '../lib/imports';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 20000;

const FIELD_OPTIONS: Array<{ value: CsvMappingTarget; label: string }> = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'firstName', label: 'First name' },
  { value: 'lastName', label: 'Last name' },
  { value: 'name', label: 'Full name' },
  { value: 'email', label: 'Email' },
  { value: 'company', label: 'Company' },
  { value: 'domain', label: 'Domain' },
  { value: 'title', label: 'Title' },
  { value: 'location', label: 'Location' },
  { value: 'linkedinUrl', label: 'LinkedIn URL' },
  { value: 'phone', label: 'Phone' },
  { value: 'website', label: 'Website' },
  { value: 'tags', label: 'Tags' },
];

const FIELD_LABELS = new Map(FIELD_OPTIONS.map((option) => [option.value, option.label]));
const KNOWN_TARGETS = new Set<string>(FIELD_OPTIONS.map((option) => option.value));
const IDENTITY_FIELDS: CsvMappingTarget[] = ['email', 'name', 'firstName', 'lastName'];
// The server joins several location columns and merges several tags columns. Every other field takes one column.
const MULTI_COLUMN_FIELDS: CsvMappingTarget[] = ['location', 'tags'];
const NOT_UTF8_MESSAGE = 'The file is not valid UTF-8 text. Save it as UTF-8 and try again.';

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeDelimiter(delimiter: string): string {
  switch (delimiter) {
    case ',':
    case 'comma':
      return 'Comma';
    case ';':
    case 'semicolon':
      return 'Semicolon';
    case '\t':
    case 'tab':
      return 'Tab';
    default:
      return delimiter ? `"${delimiter}"` : 'Unknown';
  }
}

function sampleValues(preview: CsvPreview, column: number): string[] {
  const values: string[] = [];
  for (const row of preview.sample) {
    const cell = (row[column] ?? '').trim();
    if (cell) values.push(cell);
    if (values.length === 2) break;
  }
  return values;
}

function initialTargets(preview: CsvPreview): CsvMappingTarget[] {
  return preview.headers.map((header) => {
    const suggested = preview.suggestedMapping[header];
    return suggested && KNOWN_TARGETS.has(suggested) ? (suggested as CsvMappingTarget) : 'ignore';
  });
}

interface FileInfo {
  name: string;
  size: number;
}

export function CsvImportSheet({ onClose, onStaged }: { onClose: () => void; onStaged: (run: Run) => void }) {
  const preview = useCsvPreview();
  const stage = useStageCsv();
  const inputRef = useRef<HTMLInputElement>(null);
  const readToken = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<FileInfo | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<CsvPreview | null>(null);
  const [targets, setTargets] = useState<CsvMappingTarget[]>([]);

  const reset = () => {
    readToken.current += 1;
    preview.reset();
    stage.reset();
    setFile(null);
    setContent(null);
    setFileError(null);
    setParsed(null);
    setTargets([]);
  };

  const choose = async (selected: File | undefined | null) => {
    if (!selected) return;
    reset();
    const token = readToken.current;
    setFile({ name: selected.name, size: selected.size });
    if (selected.size > MAX_BYTES) {
      setFileError(
        `${selected.name} is ${formatBytes(selected.size)}, over the ${formatBytes(MAX_BYTES)} limit. Split the file or remove columns you do not need, then choose it again.`,
      );
      return;
    }
    let text: string;
    try {
      text = await readText(selected);
    } catch (error) {
      if (token !== readToken.current) return;
      setFileError(`${selected.name} could not be read. ${errorMessage(error)} Choose the file again.`);
      return;
    }
    if (token !== readToken.current) return;
    // Bytes that are not valid UTF-8 decode to U+FFFD. Staging that would store garbled names.
    if (text.includes('\uFFFD')) {
      setFileError(NOT_UTF8_MESSAGE);
      return;
    }
    setContent(text);
    preview.mutate(
      { fileName: selected.name, content: text },
      {
        onSuccess: (result) => {
          if (token !== readToken.current) return;
          setParsed(result);
          setTargets(initialTargets(result));
        },
      },
    );
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    event.target.value = '';
    void choose(selected);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files?.[0]);
  };

  const problems = useMemo(() => {
    if (!parsed) return [];
    const found: string[] = [];
    const seenHeaders = new Map<string, number>();
    for (const header of parsed.headers) seenHeaders.set(header, (seenHeaders.get(header) ?? 0) + 1);
    const repeated = [...seenHeaders.entries()].filter(([, count]) => count > 1).map(([header]) => header || 'no header');
    if (repeated.length > 0) {
      found.push(
        `More than one column is named ${repeated.join(', ')}. Rename the columns in the file so each header is unique, then choose it again.`,
      );
    }
    if (!targets.some((target) => IDENTITY_FIELDS.includes(target))) {
      found.push('Map a column to Email, Full name, First name, or Last name. Every row needs an email or a name.');
    }
    const columnsByField = new Map<CsvMappingTarget, string[]>();
    targets.forEach((target, index) => {
      if (target === 'ignore') return;
      columnsByField.set(target, [...(columnsByField.get(target) ?? []), parsed.headers[index] || 'no header']);
    });
    for (const [field, columns] of columnsByField) {
      if (columns.length > 1 && !MULTI_COLUMN_FIELDS.includes(field)) {
        found.push(
          `${FIELD_LABELS.get(field)} is assigned to ${columns.length} columns (${columns.join(', ')}). Assign each field to one column, and set the others to Ignore.`,
        );
      }
    }
    return found;
  }, [parsed, targets]);

  const rowCount = parsed?.rowCount ?? 0;
  const canStage = Boolean(parsed && content !== null && file) && problems.length === 0 && rowCount > 0 && !stage.isPending;

  const submit = () => {
    if (!parsed || content === null || !file || !canStage) return;
    const mapping: CsvMapping = {};
    parsed.headers.forEach((header, index) => {
      mapping[header] = targets[index] ?? 'ignore';
    });
    stage.mutate({ fileName: file.name, content, mapping }, { onSuccess: onStaged });
  };

  const setTarget = (index: number, value: CsvMappingTarget) => {
    stage.reset();
    setTargets((current) => current.map((entry, position) => (position === index ? value : entry)));
  };

  return (
    <Sheet
      title="Import CSV"
      subtitle="Stage a spreadsheet for review. Nothing enters the CRM until you approve the staged rows."
      onClose={onClose}
    >
      <SheetSection title="File">
        <div
          className={`dropzone${dragging ? ' is-over' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input
            ref={inputRef}
            id="csv-file-input"
            className="sr-only"
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            tabIndex={-1}
            aria-hidden="true"
            onChange={onInputChange}
          />
          <p className="muted">
            {file ? 'Drop another file here to replace it.' : 'Drop a CSV file here.'} Up to {formatBytes(MAX_BYTES)} and{' '}
            <span className="num">{formatCount(MAX_ROWS)}</span> rows. The first row must be the column headers.
          </p>
          <div>
            <button type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={preview.isPending || stage.isPending}>
              {file ? 'Choose a different file' : 'Choose a CSV file'}
            </button>
          </div>
        </div>

        {file ? (
          <dl className="fields file-summary" aria-label="Selected file">
            <div className="field">
              <dt className="field__label">File</dt>
              <dd className="field__value">{file.name}</dd>
            </div>
            <div className="field">
              <dt className="field__label">Size</dt>
              <dd className="field__value num">{formatBytes(file.size)}</dd>
            </div>
            {parsed ? (
              <>
                <div className="field">
                  <dt className="field__label">Rows</dt>
                  <dd className="field__value num">{formatCount(parsed.rowCount)}</dd>
                </div>
                <div className="field">
                  <dt className="field__label">Columns</dt>
                  <dd className="field__value num">{formatCount(parsed.headers.length)}</dd>
                </div>
                <div className="field">
                  <dt className="field__label">Delimiter</dt>
                  <dd className="field__value">{describeDelimiter(parsed.delimiter)}</dd>
                </div>
              </>
            ) : null}
          </dl>
        ) : null}

        {fileError ? (
          <p className="inline-error" role="alert">
            {fileError}
          </p>
        ) : null}
        {preview.isPending ? (
          <p className="muted" role="status">
            Reading the file and checking its columns...
          </p>
        ) : null}
        {preview.isError ? (
          <p className="inline-error" role="alert">
            The file could not be parsed. {errorMessage(preview.error)} Nothing was staged.
          </p>
        ) : null}
      </SheetSection>

      {parsed ? (
        <SheetSection title="Match columns to fields">
          {parsed.rowCount === 0 ? (
            <p className="inline-error" role="alert">
              This file has no data rows below the header. Add rows, then choose it again.
            </p>
          ) : null}
          <p className="muted">
            Each column is matched to a field using its header. Change any match, or set a column to Ignore to leave it
            out. Ignored columns stay in the raw row for reference.
          </p>
          <p className="muted">
            Several Location columns are joined with a comma. Several Tags columns are merged.
          </p>
          <div className="data-table__wrap">
            <table className="data-table map-table">
              <caption className="sr-only">Column to field mapping</caption>
              <thead>
                <tr>
                  <th scope="col">Column</th>
                  <th scope="col">Sample values</th>
                  <th scope="col">Field</th>
                </tr>
              </thead>
              <tbody>
                {parsed.headers.map((header, index) => {
                  const samples = sampleValues(parsed, index);
                  const selectId = `csv-map-${index}`;
                  return (
                    <tr key={index}>
                      <td className="cell-name map-table__header">
                        <label htmlFor={selectId}>{header || 'No header'}</label>
                      </td>
                      <td className="map-table__samples muted">
                        {samples.length === 0 ? (
                          <span>No values</span>
                        ) : (
                          samples.map((value, position) => (
                            <span key={position} className="map-table__sample" title={value}>
                              {value}
                            </span>
                          ))
                        )}
                      </td>
                      <td>
                        <select
                          id={selectId}
                          className="input input--select"
                          value={targets[index] ?? 'ignore'}
                          onChange={(event) => setTarget(index, event.target.value as CsvMappingTarget)}
                        >
                          {FIELD_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="map-problems" aria-live="polite">
            {problems.map((problem) => (
              <p key={problem} className="inline-error">
                {problem}
              </p>
            ))}
          </div>

          {stage.isError ? (
            <p className="inline-error" role="alert">
              Could not stage the file. {errorMessage(stage.error)} Nothing was staged.
            </p>
          ) : null}

          <div className="sheet-actions">
            <button type="button" className="btn btn--primary" onClick={submit} disabled={!canStage}>
              {stage.isPending ? (
                'Staging...'
              ) : (
                <>
                  Stage <span className="num">{formatCount(rowCount)}</span> {rowCount === 1 ? 'row' : 'rows'} for review
                </>
              )}
            </button>
            <button type="button" className="btn" onClick={onClose} disabled={stage.isPending}>
              Cancel
            </button>
          </div>
        </SheetSection>
      ) : null}
    </Sheet>
  );
}
