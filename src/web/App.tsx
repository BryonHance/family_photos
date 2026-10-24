import { useEffect, useId, useState, type DragEvent } from "react";
import type { Analysis, AnalyzeError, Section, Summary } from "../shared/analysis.ts";

type Opened = { analysis: Analysis; previewUrl: string };

export function App() {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        {opened && <SummaryCard summary={opened.analysis.summary} />}
        {opened?.analysis.sections.map((section) => (
          <SectionTable key={section.name} section={section} />
        ))}
      </div>
    </main>
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

function SectionTable({ section }: { section: Section }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>{section.name}</h2>
      <table>
        <tbody>
          {section.fields.map((field, i) => (
            <tr key={`${field.tag}-${i}`}>
              <th scope="row">{field.label}</th>
              <td>{field.display ?? String(field.raw)}</td>
              <td className="raw">{field.display === undefined ? null : String(field.raw)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
