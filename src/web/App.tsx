import { useEffect, useId, useState, type DragEvent } from "react";
import type { Analysis, Section } from "../shared/analysis.ts";

type Opened = { analysis: Analysis; previewUrl: string };

export function App() {
  const [opened, setOpened] = useState<Opened | null>(null);

  useEffect(() => {
    if (!opened) return;
    return () => URL.revokeObjectURL(opened.previewUrl);
  }, [opened]);

  async function open(photo: File) {
    const form = new FormData();
    form.append("photo", photo);
    form.append("lastModified", String(photo.lastModified));
    const res = await fetch("/api/analyze", { method: "POST", body: form });
    const analysis = (await res.json()) as Analysis;
    setOpened({ analysis, previewUrl: URL.createObjectURL(photo) });
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
            }}
          />
        </label>
      </div>
      <div className="panel">
        {opened?.analysis.sections.map((section) => (
          <SectionTable key={section.name} section={section} />
        ))}
      </div>
    </main>
  );
}

function SectionTable({ section }: { section: Section }) {
  const headingId = useId();
  const tableId = useId();
  // Maker notes are proprietary and noisy, so they start out of the way.
  const [expanded, setExpanded] = useState(section.name !== "Maker notes");
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId}>
        <button
          type="button"
          className="section-toggle"
          aria-expanded={expanded}
          aria-controls={tableId}
          onClick={() => setExpanded(!expanded)}
        >
          {section.name}
        </button>
      </h2>
      <table id={tableId} hidden={!expanded}>
        <tbody>
          {section.fields.map((field, i) => (
            <tr key={`${field.tag}-${i}`}>
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
