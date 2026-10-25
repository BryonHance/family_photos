import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import type {
  Analysis,
  AnalyzeError,
  Face,
  Field,
  PersonRef,
  PersonSummary,
  Section,
  Summary,
  Warning,
} from "../shared/analysis.ts";
import { faceApi, messageOf } from "./faceApi.ts";
import { FaceBoxes, FacesSection } from "./faces.tsx";
import { PeoplePanel, type PeopleChange } from "./people.tsx";

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
  // Every Person, for autocompleting names and for the People panel.
  const [people, setPeople] = useState<PersonSummary[]>([]);

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
      // Autocomplete and the People panel keep the last list they had.
    }
  }

  function selectFace(faceId: string) {
    setSelectedFaceId(faceId);
    void refreshPeople();
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

  /** Keeps the opened Photo's names in step with a change made in the People panel. */
  function onPeopleChanged(change: PeopleChange) {
    /** The Person as they stand after the change: renamed, merged into another, or gone. */
    const afterChange = (person: PersonRef | undefined): PersonRef | undefined => {
      if (!person) return undefined;
      switch (change.kind) {
        case "renamed":
          return person.id === change.person.id ? change.person : person;
        case "merged":
          return person.id === change.from ? change.into : person;
        case "deleted":
          return person.id === change.personId ? undefined : person;
        case "deleted-all":
          return undefined;
      }
    };
    updateFaces((faces) =>
      faces.map(({ person, suggestion, ...face }) => {
        const nextPerson = afterChange(person);
        const nextSuggestion = afterChange(suggestion);
        return {
          ...face,
          ...(nextPerson && { person: nextPerson }),
          ...(nextSuggestion && { suggestion: nextSuggestion }),
        };
      }),
    );
    void refreshPeople();
  }

  async function openPhoto(photo: File) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSelectedFaceId(undefined);
    setSuggestionProblem(undefined);
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
        <PeoplePanel people={people} onOpen={refreshPeople} onChanged={onPeopleChanged} />
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
          />
        )}
      </div>
    </main>
  );
}

/** The panel for an opened Photo: Warnings, Faces, Summary, the filter box, then its Sections. */
function OpenedPhotoPanel({
  analysis,
  filter,
  onFilterChange,
  faces,
}: {
  analysis: Analysis;
  filter: string;
  onFilterChange: (filter: string) => void;
  /** The Faces section, when the Photo has any. */
  faces: ReactNode;
}) {
  return (
    <>
      {analysis.warnings.length > 0 && <Warnings warnings={analysis.warnings} />}
      {faces}
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
}: Opened & {
  showBoxes: boolean;
  selectedFaceId: string | undefined;
  onSelectFace: (faceId: string) => void;
  onConfirmSuggestion: (faceId: string, person: PersonRef) => Promise<void>;
  onRejectSuggestion: (faceId: string, person: PersonRef) => Promise<void>;
}) {
  const { preview, photo, faces } = analysis;
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
