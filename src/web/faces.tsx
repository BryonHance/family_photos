import { useId, useState } from "react";
import type { Face, PersonRef, PersonSummary, StrangerRef } from "../shared/analysis.ts";
import { messageOf } from "./faceApi.ts";

/** Who a Face shows, as far as the viewer knows: exactly one of these. */
type Who =
  | { state: "named"; person: PersonRef }
  | { state: "suggested"; person: PersonRef }
  | { state: "stranger"; stranger: StrangerRef }
  | { state: "unknown" };

function whoIs(face: Face): Who {
  if (face.person) return { state: "named", person: face.person };
  if (face.suggestion) return { state: "suggested", person: face.suggestion };
  if (face.stranger) return { state: "stranger", stranger: face.stranger };
  return { state: "unknown" };
}

/** What a Face's box says about who it shows: their name, a Suggestion, or a Stranger. */
function whoLabel(who: Who): string | undefined {
  switch (who.state) {
    case "named":
      return who.person.name;
    case "suggested":
      return `${who.person.name}?`;
    case "stranger":
      return `${who.stranger.label}, in ${who.stranger.photoCount} Photos`;
    case "unknown":
      return undefined;
  }
}

/** "Face 2", "Face 1: Neil", "Face 3: Neil? (suggested)" or "Face 4: Unknown 2, in 3 Photos". */
export function faceLabel(face: Face, index: number): string {
  const who = whoIs(face);
  const label = whoLabel(who);
  if (label === undefined) return `Face ${index + 1}`;
  return `Face ${index + 1}: ${label}${who.state === "suggested" ? " (suggested)" : ""}`;
}

const BOX_CLASS: Record<Who["state"], string> = {
  named: "face-box",
  suggested: "face-box suggested",
  stranger: "face-box stranger",
  unknown: "face-box",
};

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
      {faces.map((face, i) => {
        const who = whoIs(face);
        const label = whoLabel(who);
        return (
          <li
            key={face.id}
            className={BOX_CLASS[who.state]}
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
              {label !== undefined && <span className="face-name">{label}</span>}
            </button>
            {who.state === "suggested" && (
              <SuggestionButtons
                number={i + 1}
                person={who.person}
                onConfirm={() => onConfirm(face.id, who.person)}
                onReject={() => onReject(face.id, who.person)}
              />
            )}
          </li>
        );
      })}
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
        <NameForm
          // A fresh form for each Face, starting from its own name.
          key={selected.id}
          label={`Name Face ${index + 1}`}
          initialName={selected.person?.name ?? ""}
          names={people}
          namesLabel="People"
          dismissLabel="Not a face"
          onName={(name) => onName(selected.id, name)}
          onDismiss={() => onNotAFace(selected.id)}
          onClose={onClose}
        />
      ) : (
        <p className="hint">Click a box to name its Face.</p>
      )}
    </section>
  );
}

/**
 * Names a Face or an Animal, with names autocompleting from `names` (People for
 * a Face, Pets for an Animal, never both), or dismisses it ("Not a face", "Not a pet").
 */
export function NameForm({
  label,
  initialName,
  names,
  namesLabel,
  dismissLabel,
  onName,
  onDismiss,
  onClose,
}: {
  /** The form's accessible name, such as "Name Face 3". */
  label: string;
  initialName: string;
  names: { id: string; name: string }[];
  /** The autocomplete list's accessible name: "People" or "Pets". */
  namesLabel: string;
  dismissLabel: string;
  onName: (name: string) => Promise<void>;
  onDismiss: () => Promise<void>;
  onClose: () => void;
}) {
  const listId = useId();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const needle = name.trim().toLowerCase();
  const matches = needle === "" ? [] : names.filter((n) => n.name.toLowerCase().includes(needle));

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(messageOf(failure));
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
      aria-label={label}
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
        <ul role="listbox" id={listId} aria-label={namesLabel} className="name-options">
          {matches.map((option) => (
            <li key={option.id} role="option" aria-selected={false} onClick={() => save(option.name)}>
              {option.name}
            </li>
          ))}
        </ul>
      )}
      <div className="face-actions">
        <button type="submit" disabled={busy || needle === ""}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={() => void run(onDismiss)}>
          {dismissLabel}
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
