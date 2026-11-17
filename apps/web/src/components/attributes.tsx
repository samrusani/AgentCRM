import type { ReactNode } from 'react';
import type { AttributeReading } from '../api/types';
import { EditableMoney, EditableValue, FieldRow } from './record';

const MAX_TEXT = 2000;

const LABEL = /^\p{Lu}[\p{L}\p{M}\p{N} ()/&-]{0,39}$/u;
const BULLET = /^(?:- |\* |• )/;

type Block = { kind: 'line'; text: string; gap: boolean } | { kind: 'list'; items: string[]; gap: boolean };

function parseNote(value: string): Block[] {
  const blocks: Block[] = [];
  let gap = false;
  for (const line of value.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') {
      gap = true;
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (BULLET.test(line)) {
      const item = line.slice(2);
      if (last && last.kind === 'list' && !gap) last.items.push(item);
      else blocks.push({ kind: 'list', items: [item], gap: gap && blocks.length > 0 });
    } else {
      blocks.push({ kind: 'line', text: line, gap: gap && blocks.length > 0 });
    }
    gap = false;
  }
  return blocks;
}

function noteLine(text: string): ReactNode {
  const colon = text.indexOf(':');
  if (colon > 0 && LABEL.test(text.slice(0, colon)) && /^\s+\S/.test(text.slice(colon + 1))) {
    return (
      <>
        <span className="note__label">{text.slice(0, colon + 1)}</span>
        {text.slice(colon + 1)}
      </>
    );
  }
  return text;
}

// A saved text value shown as notes: labelled lines, bulleted lists, and paragraphs. Display only and plain text only,
// so nothing here becomes a link or markup. The stored string is untouched.
export function NoteText({ value }: { value: string }) {
  return (
    <div className="note">
      {parseNote(value).map((block, index) =>
        block.kind === 'list' ? (
          <ul key={index} className={`note__list${block.gap ? ' note__gap' : ''}`}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{item}</li>
            ))}
          </ul>
        ) : (
          <p key={index} className={`note__line${block.gap ? ' note__gap' : ''}`}>
            {noteLine(block.text)}
          </p>
        ),
      )}
    </div>
  );
}

// The custom attribute rows of a record sheet, after the built in rows and in display order. Each is an ordinary field
// row; the definition's description shows as a muted hint. Saves go through the sheet's own patch as attr:<key> fields.
export function AttributeRows({
  attributes,
  save,
  onReload,
  openClaim,
  onToggleClaim,
}: {
  attributes: AttributeReading[];
  save: (key: string, value: unknown, versionOverride?: number) => Promise<void>;
  onReload: () => Promise<unknown>;
  openClaim: string | null;
  onToggleClaim: (id: string) => void;
}) {
  return (
    <>
      {attributes.map((attribute) => (
        <FieldRow
          key={attribute.id}
          label={attribute.label}
          hint={attribute.description}
          openClaim={openClaim}
          onToggleClaim={onToggleClaim}
        >
          {attribute.kind === 'money' ? (
            <EditableMoney
              label={attribute.label}
              field={`attr:${attribute.key}`}
              amount={typeof attribute.value === 'number' ? attribute.value : null}
              currency={attribute.currency ?? 'USD'}
              save={(value, versionOverride) => save(attribute.key, value, versionOverride)}
              onReload={onReload}
            />
          ) : attribute.kind === 'number' ? (
            <EditableValue
              label={attribute.label}
              field={`attr:${attribute.key}`}
              value={attribute.value === null ? null : String(attribute.value)}
              save={async (value, versionOverride) => {
                if (value === '') return save(attribute.key, null, versionOverride);
                // Only plain decimal spellings, matching the server: a hex literal is refused, never converted.
                if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) throw new Error('Enter a plain number.');
                const parsed = Number(value);
                if (!Number.isFinite(parsed)) throw new Error('Enter a number.');
                return save(attribute.key, parsed, versionOverride);
              }}
              onReload={onReload}
            />
          ) : (
            <EditableValue
              label={attribute.label}
              field={`attr:${attribute.key}`}
              value={typeof attribute.value === 'string' ? attribute.value : null}
              save={(value, versionOverride) => save(attribute.key, value === '' ? null : value, versionOverride)}
              onReload={onReload}
              multiline
              limit={MAX_TEXT}
              renderValue={(value) => <NoteText value={value} />}
            />
          )}
        </FieldRow>
      ))}
    </>
  );
}
