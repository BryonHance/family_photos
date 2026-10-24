import { useEffect, useId, useState, type DragEvent } from "react";
import type { Analysis, AnalyzeError, Field, Section, Summary, Warning } from "../shared/analysis.ts";

type Opened = { analysis: Analysis; previewUrl: string };

export function App() {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!opened) return;
    return () => URL.revokeObjectURL(opened.previewUrl);
  }, [opened]);

  async function open(photo: File) {
    setOpened(null);
    setError(null);
    setAnalyzing(photo.name);
    try {
      const form = new FormData();
      form.append("photo", photo);
      form.append("lastModified", String(photo.lastModified));
      const res = await fetch("/api/analyze", { method: "POST", body: form });
      const body = (await res.json()) as Analysis | AnalyzeError;
      if ("error" in body) setError(body.error.message);
      else setOpened({ analysis: body, previewUrl: URL.createObjectURL(photo) });
    } catch {
      setError("The Photo could not be analyzed. Check the connection to the server and try again.");
    } finally {
      setAnalyzing(null);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    const photo = event.dataTransfer.files[0];
    if (photo) void open(photo);
  }

  return (
    <main
      className="viewer"
      data-testid="drop-zone"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="photo">
        {opened ? (
          <img src={opened.previewUrl} alt={opened.analysis.photo.name} />
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
              if (photo) void open(photo);
              // Lets the same file be picked again, for example after an error.
              event.target.value = "";
            }}
          />
        </label>
      </div>
      <div className="panel">
        {analyzing !== null && (
          <p className="loading" role="status">
            Analyzing {analyzing}…
          </p>
        )}
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {opened && opened.analysis.warnings.length > 0 ? <Warnings warnings={opened.analysis.warnings} /> : null}
        {opened && <SummaryCard summary={opened.analysis.summary} />}
        {opened && (
          <input
            type="search"
            className="filter"
            aria-label="Filter Fields"
            placeholder="Filter Fields"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        )}
        {opened?.analysis.sections.map((section) => (
          <SectionTable key={section.name} section={section} filter={filter} />
        ))}
      </div>
    </main>
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
function openStreetMapUrl({ latitude, longitude }: { latitude: number; longitude: number }) {
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
