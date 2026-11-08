import type { AttributeReading } from '../api/types';
import { EditableMoney, EditableValue, FieldRow } from './record';

const MAX_TEXT = 2000;

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
            />
          )}
        </FieldRow>
      ))}
    </>
  );
}
