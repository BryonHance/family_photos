import { useEffect, useId, useState, type DragEvent } from "react";
import type { Analysis, Section, Warning } from "../shared/analysis.ts";

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
        {opened && opened.analysis.warnings.length > 0 ? <Warnings warnings={opened.analysis.warnings} /> : null}
        {opened?.analysis.sections.map((section) => (
          <SectionTable key={section.name} section={section} />
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
