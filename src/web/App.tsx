import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import type { Analysis, AnalyzeError, Face, Field, Section, Summary, Warning } from "../shared/analysis.ts";

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

  useEffect(() => {
    if (state.status !== "opened") return;
    const { previewUrl } = state;
    return () => URL.revokeObjectURL(previewUrl);
  }, [state]);

  async function openPhoto(photo: File) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
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
        {state.status === "opened" ? <PhotoPreview {...state} showBoxes={showBoxes} /> : <p className="hint">Drop a Photo here</p>}
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
            showBoxes={showBoxes}
            onShowBoxesChange={setShowBoxes}
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
  showBoxes,
  onShowBoxesChange,
}: {
  analysis: Analysis;
  filter: string;
  onFilterChange: (filter: string) => void;
  showBoxes: boolean;
  onShowBoxesChange: (show: boolean) => void;
}) {
  return (
    <>
      {analysis.warnings.length > 0 && <Warnings warnings={analysis.warnings} />}
      {analysis.faces.length > 0 && (
        <FacesHeading count={analysis.faces.length} showBoxes={showBoxes} onShowBoxesChange={onShowBoxesChange} />
      )}
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

function PhotoPreview({ analysis, previewUrl, showBoxes }: Opened & { showBoxes: boolean }) {
  const { preview, photo, faces } = analysis;
  const framed = (src: string) => (
    <div className="preview-frame">
      <img src={src} alt={photo.name} />
      {showBoxes && faces.length > 0 && <FaceBoxes faces={faces} />}
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

/** A numbered box over each Face, placed by its fractions of the upright Photo, which the preview shows. */
function FaceBoxes({ faces }: { faces: Face[] }) {
  return (
    <ol className="face-boxes" aria-label="Face boxes">
      {faces.map(({ box }, i) => (
        <li
          key={i}
          className="face-box"
          style={{
            left: `${box.x * 100}%`,
            top: `${box.y * 100}%`,
            width: `${box.width * 100}%`,
            height: `${box.height * 100}%`,
          }}
        >
          <span>{i + 1}</span>
        </li>
      ))}
    </ol>
  );
}

function FacesHeading({
  count,
  showBoxes,
  onShowBoxesChange,
}: {
  count: number;
  showBoxes: boolean;
  onShowBoxesChange: (show: boolean) => void;
}) {
  const headingId = useId();
  return (
    <section className="faces" aria-labelledby={headingId}>
      <h2 id={headingId}>Faces ({count})</h2>
      <label>
        <input type="checkbox" checked={showBoxes} onChange={(event) => onShowBoxesChange(event.target.checked)} />
        Show boxes
      </label>
    </section>
  );
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
