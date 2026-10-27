import { useId, useState } from "react";
import type { PersonSummary, PetSummary } from "../shared/analysis.ts";
import { faceApi, messageOf } from "./faceApi.ts";
import { petApi } from "./petApi.ts";

/** A Person or a Pet, as the panel names them: the two are never mixed. */
type Named = { id: string; name: string };

/** Which side of the panel a change was made on. */
export type NamedKind = "person" | "pet";

/** A change made in the People and pets panel, which the opened Photo's names must follow. */
export type PeopleChange =
  | { of: NamedKind; kind: "renamed"; to: Named }
  | { of: NamedKind; kind: "merged"; from: string; into: Named }
  | { of: NamedKind; kind: "deleted"; id: string }
  | { kind: "deleted-all" };

/** How each side of the panel words its rows and reaches the server. */
const KINDS = {
  person: {
    count: (n: number) => `${n} ${n === 1 ? "Face" : "Faces"}`,
    mergeWarning: (from: string, into: string) => `Every Face named ${from} will be named ${into}.`,
    deleteWarning: (name: string) => `Delete ${name}? Their Faces stay stored, unnamed.`,
    rename: faceApi.renamePerson,
    merge: faceApi.mergePeople,
    remove: faceApi.deletePerson,
  },
  pet: {
    count: (n: number) => `${n} ${n === 1 ? "Animal" : "Animals"}`,
    mergeWarning: (from: string, into: string) => `Every Animal named ${from} will be named ${into}.`,
    deleteWarning: (name: string) => `Delete ${name}? Its Animals stay stored, unnamed.`,
    rename: petApi.renamePet,
    merge: petApi.mergePets,
    remove: petApi.deletePet,
  },
} satisfies Record<NamedKind, unknown>;

/**
 * Every Person with their Face count and every Pet with its Animal count, each
 * in its own section, to rename, merge or delete; and "Delete all face and pet
 * data". It shows no Photos: none are kept (ADR-0002, ADR-0003).
 */
export function PeoplePanel({
  people,
  pets,
  onOpen,
  onChanged,
}: {
  people: PersonSummary[];
  pets: PetSummary[];
  /** Called when the panel opens, to fetch the latest People and Pets. */
  onOpen: () => Promise<void>;
  onChanged: (change: PeopleChange) => void;
}) {
  const headingId = useId();
  const peopleHeadingId = useId();
  const petsHeadingId = useId();
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
      "Delete all face and pet data? Every name and every stored Face and Animal is forgotten, and each Photo must be opened again to name its Faces and Animals. This cannot be undone.",
    );
    if (confirmed) void change(async () => (await faceApi.deleteAllFaceAndPetData(), { kind: "deleted-all" }));
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
        People and pets
      </button>
      {open && (
        <section id={listId} className="people" aria-labelledby={headingId}>
          <h2 id={headingId}>People and pets</h2>
          <section aria-labelledby={peopleHeadingId}>
            <h3 id={peopleHeadingId}>People</h3>
            {people.length === 0 ? (
              <p className="hint">No one has been named yet.</p>
            ) : (
              <ul aria-label="People">
                {people.map((person) => (
                  <NamedRow key={person.id} of="person" named={person} count={person.faceCount} all={people} onChange={change} />
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby={petsHeadingId}>
            <h3 id={petsHeadingId}>Pets</h3>
            {pets.length === 0 ? (
              <p className="hint">No pet has been named yet.</p>
            ) : (
              <ul aria-label="Pets">
                {pets.map((pet) => (
                  <NamedRow key={pet.id} of="pet" named={pet} count={pet.animalCount} all={pets} onChange={change} />
                ))}
              </ul>
            )}
          </section>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="button" className="danger" onClick={deleteAll}>
            Delete all face and pet data
          </button>
        </section>
      )}
    </div>
  );
}

/** One Person or Pet, which merges only into another of its own kind, from `all`. */
function NamedRow({
  of,
  named,
  count,
  all,
  onChange,
}: {
  of: NamedKind;
  named: Named;
  count: number;
  all: Named[];
  onChange: (action: () => Promise<PeopleChange>) => Promise<void>;
}) {
  const kind = KINDS[of];
  const [mode, setMode] = useState<"view" | "rename" | "merge">("view");
  const others = all.filter((other) => other.id !== named.id);
  const [newName, setNewName] = useState(named.name);
  const [intoId, setIntoId] = useState(others[0]?.id ?? "");

  function rename() {
    const name = newName.trim();
    if (name === "" || name === named.name) return setMode("view");
    void onChange(async () => ({ of, kind: "renamed", to: await kind.rename(named.id, name) }));
    setMode("view");
  }

  function merge() {
    const into = others.find((other) => other.id === intoId);
    if (!into) return;
    const confirmed = window.confirm(`Merge ${named.name} into ${into.name}? ${kind.mergeWarning(named.name, into.name)}`);
    if (!confirmed) return;
    void onChange(async () => {
      await kind.merge(named.id, into.id);
      return { of, kind: "merged", from: named.id, into: { id: into.id, name: into.name } };
    });
    setMode("view");
  }

  function remove() {
    if (window.confirm(kind.deleteWarning(named.name))) {
      void onChange(async () => (await kind.remove(named.id), { of, kind: "deleted", id: named.id }));
    }
  }

  return (
    <li className="name-row">
      <span className="name-row-name">{named.name}</span> <span className="name-row-count">{kind.count(count)}</span>
      {mode === "view" && (
        <span className="name-row-actions">
          <button type="button" aria-label={`Rename ${named.name}`} onClick={() => setMode("rename")}>
            Rename
          </button>
          {others.length > 0 && (
            <button type="button" aria-label={`Merge ${named.name}`} onClick={() => setMode("merge")}>
              Merge
            </button>
          )}
          <button type="button" aria-label={`Delete ${named.name}`} onClick={remove}>
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
            aria-label={`New name for ${named.name}`}
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
          <select aria-label={`Merge ${named.name} into`} value={intoId} onChange={(event) => setIntoId(event.target.value)}>
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
