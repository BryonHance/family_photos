import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import type {
  Analysis,
  AnalyzeError,
  Animal,
  Face,
  Field,
  PersonRef,
  PersonSummary,
  PetRef,
  PetSummary,
  Section,
  Summary,
  Warning,
} from "../shared/analysis.ts";
import { faceApi, messageOf } from "./faceApi.ts";
import { FaceBoxes, FacesSection } from "./faces.tsx";
import { PeoplePanel, type NamedKind, type PeopleChange } from "./people.tsx";
import { petApi } from "./petApi.ts";
import { AnimalBoxes, PetsSection } from "./pets.tsx";

type Opened = { analysis: Analysis; previewUrl: string };

/** What the viewer is showing: nothing yet, a Photo being analyzed, an error, or an opened Photo. */
type ViewerState =
  | { status: "empty" }
  | { status: "analyzing"; photoName: string }
  | { status: "failed"; message: string }
  | ({ status: "opened" } & Opened);

export function App() {
  const [state, setState] = useState<ViewerState>({ status: "empty" });
  const [filter, setFilter] = useState("");
  // Kept across Photos, like the filter, so hiding the boxes once keeps them hidden.
  const [showBoxes, setShowBoxes] = useState(true);
  // The request for the Photo opened most recently. Opening another aborts it, so
  // a slower response for an earlier Photo can never replace a later one.
  const request = useRef<AbortController | null>(null);
  // The Face whose naming form is open, if any.
  const [selectedFaceId, setSelectedFaceId] = useState<string>();
  // Every Person, for autocompleting names and for the People and pets panel.
  const [people, setPeople] = useState<PersonSummary[]>([]);
  // The Animal whose naming form is open, if any. At most one form is open, for a Face or an Animal.
  const [selectedAnimalId, setSelectedAnimalId] = useState<string>();
  // Every Pet, for autocompleting an Animal's name (Pets only, never People) and for the People and pets panel.
  const [pets, setPets] = useState<PetSummary[]>([]);

  const previewUrl = state.status === "opened" ? state.previewUrl : undefined;
  useEffect(() => {
    if (previewUrl === undefined) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  /** Changes the opened Photo's Faces in place, such as after one is named. */
  function updateFaces(update: (faces: Face[]) => Face[]) {
    setState((s) => (s.status === "opened" ? { ...s, analysis: { ...s.analysis, faces: update(s.analysis.faces) } } : s));
  }

  async function refreshPeople() {
    try {
      setPeople(await faceApi.people());
    } catch {
      // Autocomplete and the People and pets panel keep the last list they had.
    }
  }

  function selectFace(faceId: string) {
    setSelectedAnimalId(undefined);
    setSelectedFaceId(faceId);
    void refreshPeople();
  }

  /** Changes the opened Photo's Animals in place, such as after one is named. */
  function updateAnimals(update: (animals: Animal[]) => Animal[]) {
    setState((s) => (s.status === "opened" ? { ...s, analysis: { ...s.analysis, animals: update(s.analysis.animals) } } : s));
  }

  async function refreshPets() {
    try {
      setPets(await petApi.pets());
    } catch {
      // Autocomplete and the People and pets panel keep the last list they had.
    }
  }

  async function refreshPeopleAndPets() {
    await Promise.all([refreshPeople(), refreshPets()]);
  }

  function selectAnimal(animalId: string) {
    setSelectedFaceId(undefined);
    setSelectedAnimalId(animalId);
    void refreshPets();
  }

  /** Shows an Animal as named, and no other Animal of the Photo as suggested to be the same Pet. */
  function showNamedAnimal(animalId: string, pet: PetRef) {
    updateAnimals((animals) =>
      animals.map((animal) =>
        animal.id === animalId
          ? { id: animal.id, species: animal.species, box: animal.box, pet }
          : animal.suggestion?.id === pet.id
            ? { id: animal.id, species: animal.species, box: animal.box }
            : animal,
      ),
    );
  }

  async function nameAnimal(animalId: string, name: string) {
    const pet = await petApi.nameAnimal(animalId, name);
    showNamedAnimal(animalId, pet);
    setSelectedAnimalId(undefined);
    await refreshPets();
  }

  // Why the last ✓ or ✕ on an Animal failed, if it did.
  const [petSuggestionProblem, setPetSuggestionProblem] = useState<string>();

  async function confirmPetSuggestion(animalId: string, suggested: PetRef) {
    setPetSuggestionProblem(undefined);
    try {
      showNamedAnimal(animalId, await petApi.confirmSuggestion(animalId, suggested.id));
    } catch (failure) {
      setPetSuggestionProblem(messageOf(failure));
      return;
    }
    await refreshPets();
  }

  async function rejectPetSuggestion(animalId: string, suggested: PetRef) {
    setPetSuggestionProblem(undefined);
    try {
      const updated = await petApi.rejectSuggestion(animalId, suggested.id);
      updateAnimals((animals) => animals.map((animal) => (animal.id === animalId ? updated : animal)));
    } catch (failure) {
      setPetSuggestionProblem(messageOf(failure));
    }
  }

  async function markNotAPet(animalId: string) {
    await petApi.markNotAPet(animalId);
    updateAnimals((animals) => animals.filter((animal) => animal.id !== animalId));
    setSelectedAnimalId(undefined);
    await refreshPets();
  }

  // Why the last ✓ or ✕ failed, if it did.
  const [suggestionProblem, setSuggestionProblem] = useState<string>();

  /** Shows a Face as named, and no other Face of the Photo as suggested to be the same Person. */
  function showNamed(faceId: string, person: PersonRef) {
    updateFaces((faces) =>
      faces.map((face) =>
        face.id === faceId
          ? { id: face.id, box: face.box, person }
          : face.suggestion?.id === person.id
            ? { id: face.id, box: face.box }
            : face,
      ),
    );
  }

  async function nameFace(faceId: string, name: string) {
    const person = await faceApi.nameFace(faceId, name);
    showNamed(faceId, person);
    setSelectedFaceId(undefined);
    await refreshPeople();
  }

  async function confirmSuggestion(faceId: string, suggested: PersonRef) {
    setSuggestionProblem(undefined);
    try {
      showNamed(faceId, await faceApi.confirmSuggestion(faceId, suggested.id));
    } catch (failure) {
      setSuggestionProblem(messageOf(failure));
      return;
    }
    await refreshPeople();
  }

  async function rejectSuggestion(faceId: string, suggested: PersonRef) {
    setSuggestionProblem(undefined);
    try {
      const updated = await faceApi.rejectSuggestion(faceId, suggested.id);
      updateFaces((faces) => faces.map((face) => (face.id === faceId ? updated : face)));
    } catch (failure) {
      setSuggestionProblem(messageOf(failure));
    }
  }

  async function markNotAFace(faceId: string) {
    await faceApi.markNotAFace(faceId);
    updateFaces((faces) => faces.filter((face) => face.id !== faceId));
    setSelectedFaceId(undefined);
    await refreshPeople();
  }

  /** Keeps the opened Photo's names in step with a change made in the People and pets panel. */
  function onPeopleChanged(change: PeopleChange) {
    /**
     * The Person or Pet as they stand after the change: renamed, merged into
     * another, or gone. A change on one side leaves the other side alone.
     */
    const afterChange = <T extends { id: string; name: string }>(of: NamedKind, named: T | undefined): T | undefined => {
      if (!named) return undefined;
      if (change.kind === "deleted-all") return undefined;
      if (change.of !== of) return named;
      switch (change.kind) {
        case "renamed":
          return named.id === change.to.id ? { ...named, name: change.to.name } : named;
        case "merged":
          return named.id === change.from ? { ...named, ...change.into } : named;
        case "deleted":
          return named.id === change.id ? undefined : named;
      }
    };
    updateFaces((faces) =>
      faces.map(({ person, suggestion, ...face }) => {
        const nextPerson = afterChange("person", person);
        const nextSuggestion = afterChange("person", suggestion);
        return {
          ...face,
          ...(nextPerson && { person: nextPerson }),
          ...(nextSuggestion && { suggestion: nextSuggestion }),
        };
      }),
    );
    updateAnimals((animals) =>
      animals.map(({ pet, suggestion, ...animal }) => {
        const nextPet = afterChange("pet", pet);
        const nextSuggestion = afterChange("pet", suggestion);
        return {
          ...animal,
          ...(nextPet && { pet: nextPet }),
          ...(nextSuggestion && { suggestion: nextSuggestion }),
        };
      }),
    );
    // Deleting all face data deletes all pet data too (ADR-0003).
    if (change.kind === "deleted-all" || change.of === "pet") void refreshPets();
    if (change.kind === "deleted-all" || change.of === "person") void refreshPeople();
  }

  async function openPhoto(photo: File) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSelectedFaceId(undefined);
    setSelectedAnimalId(undefined);
    setSuggestionProblem(undefined);
    setPetSuggestionProblem(undefined);
    setState({ status: "analyzing", photoName: photo.name });
    let next: ViewerState;
    try {
      const form = new FormData();
      form.append("photo", photo);
      form.append("lastModified", String(photo.lastModified));
      const res = await fetch("/api/analyze", { method: "POST", body: form, signal: controller.signal });
      const body = (await res.json()) as Analysis | AnalyzeError;
      next =
        "error" in body
          ? { status: "failed", message: body.error.message }
          : { status: "opened", analysis: body, previewUrl: URL.createObjectURL(photo) };
    } catch {
      next = {
        status: "failed",
        message: "The Photo could not be analyzed. Check the connection to the server and try again.",
      };
    }
    if (controller.signal.aborted) {
      if (next.status === "opened") URL.revokeObjectURL(next.previewUrl);
      return;
    }
    setState(next);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    const photo = event.dataTransfer.files[0];
    if (photo) void openPhoto(photo);
  }

  return (
    <main
      className="viewer"
      data-testid="drop-zone"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="photo">
        {state.status === "opened" ? (
          <PhotoPreview
            {...state}
            showBoxes={showBoxes}
            selectedFaceId={selectedFaceId}
            onSelectFace={selectFace}
            onConfirmSuggestion={confirmSuggestion}
            onRejectSuggestion={rejectSuggestion}
            selectedAnimalId={selectedAnimalId}
            onSelectAnimal={selectAnimal}
            onConfirmPetSuggestion={confirmPetSuggestion}
            onRejectPetSuggestion={rejectPetSuggestion}
          />
        ) : (
          <p className="hint">Drop a Photo here</p>
        )}
        <label className="picker">
          Choose a Photo
          <input
            type="file"
            accept="image/*"
            onChange={(event) => {
              const photo = event.target.files?.[0];
              if (photo) void openPhoto(photo);
              // Lets the same file be picked again, for example after an error.
              event.target.value = "";
            }}
          />
        </label>
      </div>
      <div className="panel">
        <PeoplePanel people={people} pets={pets} onOpen={refreshPeopleAndPets} onChanged={onPeopleChanged} />
        {state.status === "analyzing" && (
          <p className="loading" role="status">
            Analyzing {state.photoName}…
          </p>
        )}
        {state.status === "failed" && (
          <p className="error" role="alert">
            {state.message}
          </p>
        )}
        {state.status === "opened" && (
          <OpenedPhotoPanel
            analysis={state.analysis}
            filter={filter}
            onFilterChange={setFilter}
            faces={
              state.analysis.faces.length > 0 && (
                <FacesSection
                  faces={state.analysis.faces}
                  showBoxes={showBoxes}
                  onShowBoxesChange={setShowBoxes}
                  selectedFaceId={selectedFaceId}
                  people={people}
                  onName={nameFace}
                  onNotAFace={markNotAFace}
                  onClose={() => setSelectedFaceId(undefined)}
                  suggestionProblem={suggestionProblem}
                />
              )
            }
            pets={
              state.analysis.animals.length > 0 && (
                <PetsSection
                  animals={state.analysis.animals}
                  // "Show boxes" sits under the Faces heading when there is one.
                  toggle={
                    state.analysis.faces.length === 0 ? { showBoxes, onShowBoxesChange: setShowBoxes } : undefined
                  }
                  selectedAnimalId={selectedAnimalId}
                  pets={pets}
                  onName={nameAnimal}
                  onNotAPet={markNotAPet}
                  onClose={() => setSelectedAnimalId(undefined)}
                  suggestionProblem={petSuggestionProblem}
                />
              )
            }
          />
        )}
      </div>
    </main>
  );
}

/** The panel for an opened Photo: Warnings, Faces, Pets, Summary, the filter box, then its Sections. */
function OpenedPhotoPanel({
  analysis,
  filter,
  onFilterChange,
  faces,
  pets,
}: {
  analysis: Analysis;
  filter: string;
  onFilterChange: (filter: string) => void;
  /** The Faces section, when the Photo has any. */
  faces: ReactNode;
  /** The Pets section, when the Photo has any Animals. */
  pets: ReactNode;
}) {
  return (
    <>
      {analysis.warnings.length > 0 && <Warnings warnings={analysis.warnings} />}
      {faces}
      {pets}
      <SummaryCard summary={analysis.summary} />
      <input
        type="search"
        className="filter"
        aria-label="Filter Fields"
        placeholder="Filter Fields"
        value={filter}
        onChange={(event) => onFilterChange(event.target.value)}
      />
      {analysis.sections.map((section) => (
        <SectionTable key={section.name} section={section} filter={filter} />
      ))}
    </>
  );
}

function PhotoPreview({
  analysis,
  previewUrl,
  showBoxes,
  selectedFaceId,
  onSelectFace,
  onConfirmSuggestion,
  onRejectSuggestion,
  selectedAnimalId,
  onSelectAnimal,
  onConfirmPetSuggestion,
  onRejectPetSuggestion,
}: Opened & {
  showBoxes: boolean;
  selectedFaceId: string | undefined;
  onSelectFace: (faceId: string) => void;
  onConfirmSuggestion: (faceId: string, person: PersonRef) => Promise<void>;
  onRejectSuggestion: (faceId: string, person: PersonRef) => Promise<void>;
  selectedAnimalId: string | undefined;
  onSelectAnimal: (animalId: string) => void;
  onConfirmPetSuggestion: (animalId: string, pet: PetRef) => Promise<void>;
  onRejectPetSuggestion: (animalId: string, pet: PetRef) => Promise<void>;
}) {
  const { preview, photo, faces, animals } = analysis;
  const framed = (src: string) => (
    <div className="preview-frame">
      <img src={src} alt={photo.name} />
      {showBoxes && faces.length > 0 && (
        <FaceBoxes
          faces={faces}
          selectedFaceId={selectedFaceId}
          onSelect={onSelectFace}
          onConfirm={onConfirmSuggestion}
          onReject={onRejectSuggestion}
        />
      )}
      {showBoxes && animals.length > 0 && (
        <AnimalBoxes
          animals={animals}
          selectedAnimalId={selectedAnimalId}
          onSelect={onSelectAnimal}
          onConfirm={onConfirmPetSuggestion}
          onReject={onRejectPetSuggestion}
        />
      )}
    </div>
  );
  switch (preview.kind) {
    case "client":
      return framed(previewUrl);
    case "converted":
      return framed(`data:${preview.mimeType};base64,${preview.base64}`);
    case "none":
      return (
        <p className="no-preview">
          No preview for this format. Its metadata is shown alongside.
        </p>
      );
  }
}

function Warnings({ warnings }: { warnings: Warning[] }) {
  const headingId = useId();
  return (
    <section className="warnings" aria-labelledby={headingId}>
      <h2 id={headingId}>Warnings</h2>
      <ul>
        {warnings.map((warning) => (
          <li key={warning.kind}>{warning.message}</li>
        ))}
      </ul>
    </section>
  );
}

function SummaryCard({ summary }: { summary: Summary }) {
  const headingId = useId();
  const { exposure, location } = summary;
  const rows: [label: string, value: string | undefined][] = [
    ["Date taken", summary.dateTaken],
    ["Timezone", summary.timezone ?? "unknown"],
    ["Camera", summary.camera],
    ["Lens", summary.lens],
    ["Shutter speed", exposure?.shutter],
    ["Aperture", exposure?.aperture],
    ["ISO", exposure?.iso],
    ["Focal length", exposure?.focalLength],
  ];
  return (
    <section className="summary" aria-labelledby={headingId}>
      <h2 id={headingId}>Summary</h2>
      <dl>
        {rows.map(([label, value]) =>
          value === undefined ? null : (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ),
        )}
        <div>
          <dt>Location</dt>
          <dd>
            {location ? (
              <>
                {location.latitude}, {location.longitude}{" "}
                <a href={openStreetMapUrl(location)} target="_blank" rel="noopener noreferrer">
                  Open in OpenStreetMap
                </a>
              </>
            ) : (
              "no location"
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/** A plain link: no map service hears of the location until the user clicks it (ADR-0001). */
function openStreetMapUrl({ latitude, longitude }: NonNullable<Summary["location"]>) {
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=15/${latitude}/${longitude}`;
}

function SectionTable({ section, filter }: { section: Section; filter: string }) {
  const headingId = useId();
  const tableId = useId();
  // Maker notes are proprietary and noisy, so they start out of the way.
  const [expanded, setExpanded] = useState(section.name !== "Maker notes");
  const filtering = filter.trim() !== "";
  const fields = section.fields
    .map((field, i) => ({ field, key: `${field.tag}-${i}` }))
    .filter(({ field }) => matches(field, filter));
  // While filtering, every match is shown, even in a collapsed Section. The Section is
  // hidden rather than unmounted when nothing matches, so it keeps its collapsed or
  // expanded state for when the filter is cleared.
  const open = filtering || expanded;
  return (
    <section aria-labelledby={headingId} hidden={fields.length === 0}>
      <h2 id={headingId}>
        <button
          type="button"
          className="section-toggle"
          aria-expanded={open}
          aria-controls={tableId}
          disabled={filtering}
          onClick={() => setExpanded(!expanded)}
        >
          {section.name}
        </button>
      </h2>
      <table id={tableId} hidden={!open}>
        <tbody>
          {fields.map(({ field, key }) => (
            <tr key={key}>
              <th scope="row" title={field.tag}>
                {field.label}
              </th>
              <td>{field.display ?? String(field.raw)}</td>
              <td className="raw">{field.display === undefined ? null : String(field.raw)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** A Field matches when its label, Tag name, Raw value or Display value contains the filter text. */
function matches(field: Field, filter: string) {
  const needle = filter.trim().toLowerCase();
  return [field.label, field.tag, String(field.raw), field.display ?? ""].some((text) =>
    text.toLowerCase().includes(needle),
  );
}
