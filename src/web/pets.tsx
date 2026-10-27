import { useId } from "react";
import type { Animal } from "../shared/analysis.ts";

/**
 * A box over each Animal, placed by its fractions of the upright Photo, which
 * the preview shows. Styled apart from Face boxes and labelled with the species
 * the viewer took it for.
 */
export function AnimalBoxes({ animals }: { animals: Animal[] }) {
  return (
    <ol className="animal-boxes" aria-label="Animal boxes">
      {animals.map((animal, i) => (
        <li
          key={i}
          className="animal-box"
          style={{
            left: `${animal.box.x * 100}%`,
            top: `${animal.box.y * 100}%`,
            width: `${animal.box.width * 100}%`,
            height: `${animal.box.height * 100}%`,
          }}
        >
          <span className="animal-species">{animal.species}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The panel's Animals: their count beside the Faces' count. It carries the
 * "Show boxes" toggle only when the Photo has no Faces section to carry it.
 */
export function PetsSection({
  animals,
  toggle,
}: {
  animals: Animal[];
  toggle?: { showBoxes: boolean; onShowBoxesChange: (show: boolean) => void } | undefined;
}) {
  const headingId = useId();
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
    </section>
  );
}
