import { useId } from "react";
import type { Animal, PetSummary } from "../shared/analysis.ts";
import { NameForm } from "./faces.tsx";

/** "Animal 2: cat" or "Animal 1: Rex (dog)". */
export function animalLabel(animal: Animal, index: number): string {
  return animal.pet
    ? `Animal ${index + 1}: ${animal.pet.name} (${animal.species})`
    : `Animal ${index + 1}: ${animal.species}`;
}

/**
 * A box over each Animal, placed by its fractions of the upright Photo, which
 * the preview shows. Styled apart from Face boxes and labelled with the species
 * the viewer took it for, and its Pet's name once named. Clicking a box selects
 * its Animal for naming.
 */
export function AnimalBoxes({
  animals,
  selectedAnimalId,
  onSelect,
}: {
  animals: Animal[];
  selectedAnimalId: string | undefined;
  onSelect: (animalId: string) => void;
}) {
  return (
    <ol className="animal-boxes" aria-label="Animal boxes">
      {animals.map((animal, i) => (
        <li
          key={animal.id}
          className="animal-box"
          style={{
            left: `${animal.box.x * 100}%`,
            top: `${animal.box.y * 100}%`,
            width: `${animal.box.width * 100}%`,
            height: `${animal.box.height * 100}%`,
          }}
        >
          <button
            type="button"
            aria-label={animalLabel(animal, i)}
            aria-pressed={animal.id === selectedAnimalId}
            onClick={() => onSelect(animal.id)}
          >
            {animal.pet && <span className="animal-name">{animal.pet.name}</span>}
            <span className="animal-species">{animal.species}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * The panel's Animals: their count beside the Faces' count, and the form for
 * the selected Animal. It carries the "Show boxes" toggle only when the Photo
 * has no Faces section to carry it.
 */
export function PetsSection({
  animals,
  toggle,
  selectedAnimalId,
  pets,
  onName,
  onNotAPet,
  onClose,
}: {
  animals: Animal[];
  toggle?: { showBoxes: boolean; onShowBoxesChange: (show: boolean) => void } | undefined;
  selectedAnimalId: string | undefined;
  /** Every Pet, for autocompleting names: never People. */
  pets: PetSummary[];
  onName: (animalId: string, name: string) => Promise<void>;
  onNotAPet: (animalId: string) => Promise<void>;
  onClose: () => void;
}) {
  const headingId = useId();
  const index = animals.findIndex((animal) => animal.id === selectedAnimalId);
  const selected = animals[index];
  return (
    <section className="pets" aria-labelledby={headingId}>
      <h2 id={headingId}>Pets ({animals.length})</h2>
      {toggle && (
        <label>
          <input
            type="checkbox"
            checked={toggle.showBoxes}
            onChange={(event) => toggle.onShowBoxesChange(event.target.checked)}
          />
          Show boxes
        </label>
      )}
      {selected ? (
        <NameForm
          // A fresh form for each Animal, starting from its own Pet's name.
          key={selected.id}
          label={`Name Animal ${index + 1}`}
          initialName={selected.pet?.name ?? ""}
          names={pets}
          namesLabel="Pets"
          dismissLabel="Not a pet"
          onName={(name) => onName(selected.id, name)}
          onDismiss={() => onNotAPet(selected.id)}
          onClose={onClose}
        />
      ) : (
        <p className="hint">Click a box to name its Animal.</p>
      )}
    </section>
  );
}
