import { useId, useState } from "react";
import type { Face, PersonRef, PersonSummary } from "../shared/analysis.ts";

/** What a Face's box says about who it shows: their name, a Suggestion, or a Stranger. */
function whoLabel(face: Face): string | undefined {
  if (face.person) return face.person.name;
  if (face.suggestion) return `${face.suggestion.name}?`;
  if (face.stranger) return `${face.stranger.label}, in ${face.stranger.photoCount} Photos`;
  return undefined;
}

/** "Face 2", "Face 1: Neil", "Face 3: Neil? (suggested)" or "Face 4: Unknown 2, in 3 Photos". */
export function faceLabel(face: Face, index: number): string {
  const who = whoLabel(face);
  if (who === undefined) return `Face ${index + 1}`;
  return `Face ${index + 1}: ${who}${face.suggestion ? " (suggested)" : ""}`;
}

/**
 * A numbered box over each Face, placed by its fractions of the upright Photo,
 * which the preview shows. Clicking a box selects its Face for naming. A box
 * with a Suggestion carries ✓ and ✕ to confirm or reject it in one click.
 */
export function FaceBoxes({
  faces,
  selectedFaceId,
  onSelect,
  onConfirm,
  onReject,
}: {
  faces: Face[];
  selectedFaceId: string | undefined;
  onSelect: (faceId: string) => void;
  onConfirm: (faceId: string, person: PersonRef) => Promise<void>;
  onReject: (faceId: string, person: PersonRef) => Promise<void>;
}) {
  return (
    <ol className="face-boxes" aria-label="Face boxes">
      {faces.map((face, i) => (
        <li
          key={face.id}
          className={face.suggestion ? "face-box suggested" : face.stranger ? "face-box stranger" : "face-box"}
          style={{
            left: `${face.box.x * 100}%`,
            top: `${face.box.y * 100}%`,
            width: `${face.box.width * 100}%`,
            height: `${face.box.height * 100}%`,
          }}
        >
          <button
            type="button"
            aria-label={faceLabel(face, i)}
            aria-pressed={face.id === selectedFaceId}
            onClick={() => onSelect(face.id)}
          >
            <span className="face-number">{i + 1}</span>
            {whoLabel(face) !== undefined && <span className="face-name">{whoLabel(face)}</span>}
          </button>
          {face.suggestion && (
            <SuggestionButtons
              number={i + 1}
              person={face.suggestion}
              onConfirm={() => onConfirm(face.id, face.suggestion!)}
              onReject={() => onReject(face.id, face.suggestion!)}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

/** ✓ and ✕ for a Suggestion. */
function SuggestionButtons({
  number,
  person,
  onConfirm,
  onReject,
}: {
  number: number;
  person: PersonRef;
  onConfirm: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="suggestion-actions">
      <button
        type="button"
        aria-label={`✓ Face ${number} is ${person.name}`}
        title={`Yes, this is ${person.name}`}
        disabled={busy}
        onClick={() => void run(onConfirm)}
      >
        ✓
      </button>
      <button
        type="button"
        aria-label={`✕ Face ${number} is not ${person.name}`}
        title={`No, this is not ${person.name}`}
        disabled={busy}
        onClick={() => void run(onReject)}
      >
        ✕
      </button>
    </span>
  );
}

/** The panel's Faces: their count, the "Show boxes" toggle, and the form for the selected Face. */
export function FacesSection({
  faces,
  showBoxes,
  onShowBoxesChange,
  selectedFaceId,
  people,
  onName,
  onNotAFace,
  onClose,
  suggestionProblem,
}: {
  faces: Face[];
  showBoxes: boolean;
  onShowBoxesChange: (show: boolean) => void;
  selectedFaceId: string | undefined;
  people: PersonSummary[];
  onName: (faceId: string, name: string) => Promise<void>;
  onNotAFace: (faceId: string) => Promise<void>;
  onClose: () => void;
  /** Why the last ✓ or ✕ failed, if it did. */
  suggestionProblem?: string | undefined;
}) {
  const headingId = useId();
  const index = faces.findIndex((face) => face.id === selectedFaceId);
  const selected = faces[index];
  return (
    <section className="faces" aria-labelledby={headingId}>
      <h2 id={headingId}>Faces ({faces.length})</h2>
      <label>
        <input type="checkbox" checked={showBoxes} onChange={(event) => onShowBoxesChange(event.target.checked)} />
        Show boxes
      </label>
      {suggestionProblem && (
        <p className="error" role="alert">
          {suggestionProblem}
        </p>
      )}
      {selected ? (
        <FaceForm
          // A fresh form for each Face, starting from its own name.
          key={selected.id}
          face={selected}
          number={index + 1}
          people={people}
          onName={(name) => onName(selected.id, name)}
          onNotAFace={() => onNotAFace(selected.id)}
          onClose={onClose}
        />
      ) : (
        <p className="hint">Click a box to name its Face.</p>
      )}
    </section>
  );
}

/** Names a Face, with names autocompleting from existing People, or marks it "Not a face". */
function FaceForm({
  face,
  number,
  people,
  onName,
  onNotAFace,
  onClose,
}: {
  face: Face;
  number: number;
  people: PersonSummary[];
  onName: (name: string) => Promise<void>;
  onNotAFace: () => Promise<void>;
  onClose: () => void;
}) {
  const listId = useId();
  const [name, setName] = useState(face.person?.name ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const needle = name.trim().toLowerCase();
  const matches = needle === "" ? [] : people.filter((p) => p.name.toLowerCase().includes(needle));

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  const save = (chosen: string) => {
    if (chosen.trim() !== "") void run(() => onName(chosen.trim()));
  };

  return (
    <form
      className="face-form"
      aria-label={`Name Face ${number}`}
      onSubmit={(event) => {
        event.preventDefault();
        save(name);
      }}
    >
      <label>
        Name
        <input
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={matches.length > 0}
          aria-controls={listId}
          autoComplete="off"
          autoFocus
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {matches.length > 0 && (
        <ul role="listbox" id={listId} aria-label="People" className="name-options">
          {matches.map((person) => (
            <li key={person.id} role="option" aria-selected={false} onClick={() => save(person.name)}>
              {person.name}
            </li>
          ))}
        </ul>
      )}
      <div className="face-actions">
        <button type="submit" disabled={busy || needle === ""}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={() => void run(onNotAFace)}>
          Not a face
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
