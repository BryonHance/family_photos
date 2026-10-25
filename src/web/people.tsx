import { useId, useState } from "react";
import type { PersonRef, PersonSummary } from "../shared/analysis.ts";
import { faceApi, messageOf } from "./faceApi.ts";

/** A change made in the People panel, which the opened Photo's names must follow. */
export type PeopleChange =
  | { kind: "renamed"; person: PersonRef }
  | { kind: "merged"; from: string; into: PersonRef }
  | { kind: "deleted"; personId: string }
  | { kind: "deleted-all" };

/**
 * Every Person with their Face count, to rename, merge or delete, and "Delete
 * all face data". It shows no Photos: none are kept (ADR-0002).
 */
export function PeoplePanel({
  people,
  onOpen,
  onChanged,
}: {
  people: PersonSummary[];
  /** Called when the panel opens, to fetch the latest People. */
  onOpen: () => Promise<void>;
  onChanged: (change: PeopleChange) => void;
}) {
  const headingId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();

  /** Runs a change against the server, then tells the viewer; a refusal is shown in the panel. */
  async function change(action: () => Promise<PeopleChange>) {
    setError(undefined);
    try {
      onChanged(await action());
    } catch (failure) {
      setError(messageOf(failure));
    }
  }

  function deleteAll() {
    const confirmed = window.confirm(
      "Delete all face data? Every name and every stored Face is forgotten, and each Photo must be opened again to name its Faces. This cannot be undone.",
    );
    if (confirmed) void change(async () => (await faceApi.deleteAllFaceData(), { kind: "deleted-all" }));
  }

  return (
    <div className="people-panel">
      <button
        type="button"
        className="people-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          if (!open) void onOpen();
          setOpen(!open);
        }}
      >
        People
      </button>
      {open && (
        <section id={listId} className="people" aria-labelledby={headingId}>
          <h2 id={headingId}>People</h2>
          {people.length === 0 ? (
            <p className="hint">No one has been named yet.</p>
          ) : (
            <ul aria-label="People">
              {people.map((person) => (
                <PersonRow key={person.id} person={person} people={people} onChange={change} />
              ))}
            </ul>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="danger" onClick={deleteAll}>
            Delete all face data
          </button>
        </section>
      )}
    </div>
  );
}

function PersonRow({
  person,
  people,
  onChange,
}: {
  person: PersonSummary;
  people: PersonSummary[];
  onChange: (action: () => Promise<PeopleChange>) => Promise<void>;
}) {
  const [mode, setMode] = useState<"view" | "rename" | "merge">("view");
  const others = people.filter((p) => p.id !== person.id);
  const [newName, setNewName] = useState(person.name);
  const [intoId, setIntoId] = useState(others[0]?.id ?? "");

  function rename() {
    const name = newName.trim();
    if (name === "" || name === person.name) return setMode("view");
    void onChange(async () => ({ kind: "renamed", person: await faceApi.renamePerson(person.id, name) }));
    setMode("view");
  }

  function merge() {
    const into = others.find((p) => p.id === intoId);
    if (!into) return;
    const confirmed = window.confirm(
      `Merge ${person.name} into ${into.name}? Every Face named ${person.name} will be named ${into.name}.`,
    );
    if (!confirmed) return;
    void onChange(async () => {
      await faceApi.mergePeople(person.id, into.id);
      return { kind: "merged", from: person.id, into: { id: into.id, name: into.name } };
    });
    setMode("view");
  }

  function remove() {
    const confirmed = window.confirm(`Delete ${person.name}? Their Faces stay stored, unnamed.`);
    if (confirmed) void onChange(async () => (await faceApi.deletePerson(person.id), { kind: "deleted", personId: person.id }));
  }

  return (
    <li className="person">
      <span className="person-name">{person.name}</span>{" "}
      <span className="person-count">
        {person.faceCount} {person.faceCount === 1 ? "Face" : "Faces"}
      </span>
      {mode === "view" && (
        <span className="person-actions">
          <button type="button" aria-label={`Rename ${person.name}`} onClick={() => setMode("rename")}>
            Rename
          </button>
          {others.length > 0 && (
            <button type="button" aria-label={`Merge ${person.name}`} onClick={() => setMode("merge")}>
              Merge
            </button>
          )}
          <button type="button" aria-label={`Delete ${person.name}`} onClick={remove}>
            Delete
          </button>
        </span>
      )}
      {mode === "rename" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            rename();
          }}
        >
          <input
            aria-label={`New name for ${person.name}`}
            value={newName}
            autoFocus
            onChange={(event) => setNewName(event.target.value)}
          />
          <button type="submit">Save</button>
          <button type="button" onClick={() => setMode("view")}>
            Cancel
          </button>
        </form>
      )}
      {mode === "merge" && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            merge();
          }}
        >
          <select aria-label={`Merge ${person.name} into`} value={intoId} onChange={(event) => setIntoId(event.target.value)}>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
          </select>
          <button type="submit">Merge</button>
          <button type="button" onClick={() => setMode("view")}>
            Cancel
          </button>
        </form>
      )}
    </li>
  );
}
