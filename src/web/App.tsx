import { useEffect, useId, useState, type DragEvent } from "react";
import type { Analysis, AnalyzeError, Section } from "../shared/analysis.ts";

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
        {opened?.analysis.sections.map((section) => (
          <SectionTable key={section.name} section={section} />
        ))}
      </div>
    </main>
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
