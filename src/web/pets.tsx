import { useId } from "react";
import type { Animal, PetRef, PetSummary, UnknownPetRef } from "../shared/analysis.ts";
import { NameForm, SuggestionButtons } from "./faces.tsx";

/** Which Pet an Animal shows, as far as the viewer knows: exactly one of these. */
type Which =
  | { state: "named"; pet: PetRef }
  | { state: "suggested"; pet: PetRef }
  | { state: "unknown-pet"; unknownPet: UnknownPetRef }
  | { state: "unknown" };

function whichIs(animal: Animal): Which {
  if (animal.pet) return { state: "named", pet: animal.pet };
  if (animal.suggestion) return { state: "suggested", pet: animal.suggestion };
  if (animal.unknownPet) return { state: "unknown-pet", unknownPet: animal.unknownPet };
  return { state: "unknown" };
}

/** What an Animal's box says about which Pet it shows: its name, a Suggestion, or an Unknown pet. */
function whichLabel(which: Which): string | undefined {
  switch (which.state) {
    case "named":
      return which.pet.name;
    case "suggested":
      return `${which.pet.name}?`;
    case "unknown-pet":
      return `${which.unknownPet.label}, in ${which.unknownPet.photoCount} Photos`;
    case "unknown":
      return undefined;
  }
}

/**
 * "Animal 2: cat", "Animal 1: Rex (dog)", "Animal 3: Rex? (dog, suggested)" or
 * "Animal 4: Unknown pet 2, in 5 Photos (cat)".
 */
export function animalLabel(animal: Animal, index: number): string {
  const which = whichIs(animal);
  const label = whichLabel(which);
  if (label === undefined) return `Animal ${index + 1}: ${animal.species}`;
  return `Animal ${index + 1}: ${label} (${animal.species}${which.state === "suggested" ? ", suggested" : ""})`;
}

const BOX_CLASS: Record<Which["state"], string> = {
  named: "animal-box",
  suggested: "animal-box suggested",
  "unknown-pet": "animal-box unknown-pet",
  unknown: "animal-box",
};

/**
 * A box over each Animal, placed by its fractions of the upright Photo, which
 * the preview shows. Styled apart from Face boxes and labelled with the species
 * the viewer took it for, and its Pet's name, Suggestion or Unknown pet.
 * Clicking a box selects its Animal for naming. A box with a Suggestion carries
 * ✓ and ✕ to confirm or reject it in one click.
 */
export function AnimalBoxes({
  animals,
  selectedAnimalId,
  onSelect,
  onConfirm,
  onReject,
}: {
  animals: Animal[];
  selectedAnimalId: string | undefined;
  onSelect: (animalId: string) => void;
  onConfirm: (animalId: string, pet: PetRef) => Promise<void>;
  onReject: (animalId: string, pet: PetRef) => Promise<void>;
}) {
  return (
    <ol className="animal-boxes" aria-label="Animal boxes">
      {animals.map((animal, i) => {
        const which = whichIs(animal);
        const label = whichLabel(which);
        return (
          <li
            key={animal.id}
            className={BOX_CLASS[which.state]}
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
              {label !== undefined && <span className="animal-name">{label}</span>}
              <span className="animal-species">{animal.species}</span>
            </button>
            {which.state === "suggested" && (
              <SuggestionButtons
                subject={`Animal ${i + 1}`}
                suggested={which.pet}
                onConfirm={() => onConfirm(animal.id, which.pet)}
                onReject={() => onReject(animal.id, which.pet)}
              />
            )}
          </li>
        );
      })}
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
  suggestionProblem,
}: {
  animals: Animal[];
  toggle?: { showBoxes: boolean; onShowBoxesChange: (show: boolean) => void } | undefined;
  selectedAnimalId: string | undefined;
  /** Every Pet, for autocompleting names: never People. */
  pets: PetSummary[];
  onName: (animalId: string, name: string) => Promise<void>;
  onNotAPet: (animalId: string) => Promise<void>;
  onClose: () => void;
  /** Why the last ✓ or ✕ on an Animal failed, if it did. */
  suggestionProblem?: string | undefined;
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
      {suggestionProblem && (
        <p className="error" role="alert">
          {suggestionProblem}
        </p>
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
