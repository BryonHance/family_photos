import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Analysis, PersonSummary, PetSummary } from "../shared/analysis.ts";
import { App } from "./App.tsx";

const analysis: Analysis = {
  photo: { name: "beach.jpg", sizeBytes: 1000, mimeType: "image/jpeg" },
  preview: { kind: "client" },
  warnings: [],
  summary: {},
  sections: [
    {
      name: "File",
      fields: [{ tag: "FileName", label: "File Name", raw: "beach.jpg" }],
    },
    {
      name: "EXIF",
      fields: [
        { tag: "Make", label: "Make", raw: "Canon" },
        { tag: "ExposureTime", label: "Exposure Time", raw: 0.004, display: "1/250" },
      ],
    },
  ],
  faces: [],
  animals: [],
};

const photo =new File(["jpeg bytes"], "beach.jpg", { type: "image/jpeg" });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(analysis)));
  URL.createObjectURL = vi.fn(() => "blob:beach");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shows a picked Photo beside its Sections and Fields", async () => {
  render(<App />);

  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);

  expect(await screen.findByRole("img", { name: "beach.jpg" })).toHaveAttribute("src", "blob:beach");
  const exif = screen.getByRole("region", { name: "EXIF" });
  const exposure = within(exif).getByText("Exposure Time").closest("tr")!;
  expect(within(exposure).getByText("1/250")).toBeInTheDocument();
  expect(within(exposure).getByText("0.004")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "File" })).getByText("File Name")).toBeInTheDocument();
});

it("shows only one value when a Field's Display value matches its Raw value", async () => {
  render(<App />);

  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);

  const make = (await screen.findByText("Make")).closest("tr")!;
  expect(within(make).getAllByText("Canon")).toHaveLength(1);
});

it("analyzes a Photo dropped onto the page", async () => {
  render(<App />);

  fireEvent.drop(screen.getByTestId("drop-zone"), { dataTransfer: { files: [photo], types: ["Files"] } });

  const exif = await screen.findByRole("region", { name: "EXIF" });
  expect(within(exif).getByText("Exposure Time")).toBeInTheDocument();
  expect(within(exif).getByText("1/250")).toBeInTheDocument();
  const [url, init] = vi.mocked(fetch).mock.calls[0]!;
  expect(url).toBe("/api/analyze");
  const body = init?.body as FormData;
  expect(body.get("photo")).toBeInstanceOf(File);
  expect(body.get("lastModified")).toBe(String(photo.lastModified));
});

it.each([
  [400, "no-photo", "No Photo was sent. Choose a Photo to analyze."],
  [413, "too-large", "This file is too large. Photos must be 200 MB or smaller."],
  [415, "unsupported-file", "This file is not a supported Photo (application/pdf). Open a JPEG, PNG, WebP, HEIC, TIFF or RAW Photo."],
])("shows the server's message when it rejects an upload with %i", async (status, kind, message) => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { kind, message } }, { status }));
  render(<App />);

  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);

  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
});

it("shows a loading indicator while the Photo is being analyzed", async () => {
  let respond!: (res: Response) => void;
  vi.mocked(fetch).mockReturnValueOnce(new Promise((resolve) => (respond = resolve)));
  render(<App />);

  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);

  expect(screen.getByRole("status")).toHaveTextContent(/analyzing beach\.jpg/i);
  respond(Response.json(analysis));
  expect(await screen.findByRole("region", { name: "EXIF" })).toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("replaces the first Photo when a second one is opened, without a reload", async () => {
  const second: Analysis = {
    ...analysis,
    photo: { name: "garden.jpg", sizeBytes: 2000, mimeType: "image/jpeg" },
    sections: [{ name: "File", fields: [{ tag: "FileName", label: "File Name", raw: "garden.jpg" }] }],
  };
  vi.mocked(fetch)
    .mockResolvedValueOnce(Response.json(analysis))
    .mockResolvedValueOnce(Response.json(second));
  vi.mocked(URL.createObjectURL).mockReturnValueOnce("blob:beach").mockReturnValueOnce("blob:garden");
  render(<App />);
  const picker = screen.getByLabelText(/choose a photo/i);

  await userEvent.upload(picker, photo);
  expect(await screen.findByRole("img", { name: "beach.jpg" })).toBeInTheDocument();
  await userEvent.upload(picker, new File(["more jpeg bytes"], "garden.jpg", { type: "image/jpeg" }));

  expect(await screen.findByRole("img", { name: "garden.jpg" })).toHaveAttribute("src", "blob:garden");
  expect(screen.queryByRole("img", { name: "beach.jpg" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "EXIF" })).not.toBeInTheDocument();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:beach");
});

it("ignores a slower response for an earlier Photo once a later one is opened", async () => {
  const garden: Analysis = {
    ...analysis,
    photo: { name: "garden.jpg", sizeBytes: 2000, mimeType: "image/jpeg" },
    sections: [{ name: "File", fields: [{ tag: "FileName", label: "File Name", raw: "garden.jpg" }] }],
  };
  let respondBeach!: (res: Response) => void;
  let respondGarden!: (res: Response) => void;
  vi.mocked(fetch)
    .mockReturnValueOnce(new Promise((resolve) => (respondBeach = resolve)))
    .mockReturnValueOnce(new Promise((resolve) => (respondGarden = resolve)));
  vi.mocked(URL.createObjectURL).mockReturnValueOnce("blob:beach").mockReturnValueOnce("blob:garden");
  render(<App />);
  const picker = screen.getByLabelText(/choose a photo/i);

  await userEvent.upload(picker, photo);
  await userEvent.upload(picker, new File(["more jpeg bytes"], "garden.jpg", { type: "image/jpeg" }));

  // The earlier Photo's response arrives while the later one is still analyzing.
  respondBeach(Response.json(analysis));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByRole("img", { name: "beach.jpg" })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/analyzing garden\.jpg/i);

  respondGarden(Response.json(garden));
  expect(await screen.findByRole("img", { name: "garden.jpg" })).toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "EXIF" })).not.toBeInTheDocument();
});

it("keeps a later Photo when the earlier Photo's response arrives after it", async () => {
  const garden: Analysis = {
    ...analysis,
    photo: { name: "garden.jpg", sizeBytes: 2000, mimeType: "image/jpeg" },
    sections: [{ name: "File", fields: [{ tag: "FileName", label: "File Name", raw: "garden.jpg" }] }],
  };
  let respondBeach!: (res: Response) => void;
  vi.mocked(fetch)
    .mockReturnValueOnce(new Promise((resolve) => (respondBeach = resolve)))
    .mockResolvedValueOnce(Response.json(garden));
  vi.mocked(URL.createObjectURL).mockReturnValueOnce("blob:beach").mockReturnValueOnce("blob:garden");
  render(<App />);
  const picker = screen.getByLabelText(/choose a photo/i);

  await userEvent.upload(picker, photo);
  await userEvent.upload(picker, new File(["more jpeg bytes"], "garden.jpg", { type: "image/jpeg" }));
  expect(await screen.findByRole("img", { name: "garden.jpg" })).toBeInTheDocument();

  respondBeach(Response.json(analysis));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.getByRole("img", { name: "garden.jpg" })).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: "beach.jpg" })).not.toBeInTheDocument();
});

it("clears an earlier error once a Photo opens successfully", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ error: { kind: "too-large", message: "Too large." } }, { status: 413 }),
  );
  render(<App />);
  const picker = screen.getByLabelText(/choose a photo/i);

  await userEvent.upload(picker, photo);
  await screen.findByRole("alert");
  await userEvent.upload(picker, photo);

  expect(await screen.findByRole("region", { name: "EXIF" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

const fullSummary: Analysis["summary"] = {
  dateTaken: "2024:07:04 18:30:00",
  timezone: "-07:00",
  camera: "Canon EOS R6",
  lens: "RF24-105mm F4 L IS USM",
  exposure: { shutter: "1/250", aperture: "f/4", iso: "200", focalLength: "50.0 mm" },
  location: { latitude: 37.7749, longitude: -122.4194 },
};

async function openPhotoWith(summary: Analysis["summary"]) {
  vi.mocked(fetch).mockResolvedValue(Response.json({ ...analysis, summary }));
  render(<App />);
  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);
  return screen.findByRole("region", { name: "Summary" });
}

const summaryValue = (summary: HTMLElement, label: string) =>
  within(summary).getByText(label).nextElementSibling?.textContent;

it("shows the Summary's Date taken, timezone, camera, lens, exposure and location", async () => {
  const summary = await openPhotoWith(fullSummary);

  expect(summaryValue(summary, "Date taken")).toBe("2024:07:04 18:30:00");
  expect(summaryValue(summary, "Timezone")).toBe("-07:00");
  expect(summaryValue(summary, "Camera")).toBe("Canon EOS R6");
  expect(summaryValue(summary, "Lens")).toBe("RF24-105mm F4 L IS USM");
  expect(summaryValue(summary, "Shutter speed")).toBe("1/250");
  expect(summaryValue(summary, "Aperture")).toBe("f/4");
  expect(summaryValue(summary, "ISO")).toBe("200");
  expect(summaryValue(summary, "Focal length")).toBe("50.0 mm");
  expect(summaryValue(summary, "Location")).toContain("37.7749, -122.4194");
});

it("says 'no location' and an 'unknown' timezone when the Summary has neither", async () => {
  const summary = await openPhotoWith({ dateTaken: "2023:12:25 09:15:00", camera: "Google Pixel 8" });

  expect(summaryValue(summary, "Date taken")).toBe("2023:12:25 09:15:00");
  expect(summaryValue(summary, "Timezone")).toBe("unknown");
  expect(summaryValue(summary, "Location")).toBe("no location");
});

it("links the Photo's location to OpenStreetMap", async () => {
  const summary = await openPhotoWith(fullSummary);

  const link = within(summary).getByRole("link", { name: /openstreetmap/i });
  const url = new URL(link.getAttribute("href")!);
  expect(url.origin).toBe("https://www.openstreetmap.org");
  expect(url.searchParams.get("mlat")).toBe("37.7749");
  expect(url.searchParams.get("mlon")).toBe("-122.4194");
  expect(url.hash).toContain("37.7749/-122.4194");
});

it("offers no OpenStreetMap link when the Photo has no location", async () => {
  const summary = await openPhotoWith({ camera: "Google Pixel 8" });

  expect(within(summary).queryByRole("link", { name: /openstreetmap/i })).not.toBeInTheDocument();
});

const everySection: Analysis = {
  ...analysis,
  sections: [
    ...analysis.sections,
    { name: "GPS", fields: [{ tag: "GPSLatitudeRef", label: "GPS Latitude Ref", raw: "N", display: "North" }] },
    {
      name: "Maker notes",
      fields: [{ tag: "CanonModelID", label: "Canon Model ID", raw: 2147484755, display: "EOS R6" }],
    },
  ],
};

async function openPhoto(response: Analysis) {
  vi.mocked(fetch).mockImplementation(async () => Response.json(response));
  render(<App />);
  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);
  await screen.findByRole("region", { name: "File" });
}

it("collapses and expands a Section", async () => {
  await openPhoto(everySection);
  const gps = screen.getByRole("region", { name: "GPS" });
  const toggle = within(gps).getByRole("button", { name: "GPS" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(within(gps).getByText("North")).toBeVisible();

  await userEvent.click(toggle);

  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(within(gps).getByText("North")).not.toBeVisible();

  await userEvent.click(toggle);

  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(within(gps).getByText("North")).toBeVisible();
});

it("starts every Section expanded except Maker notes, which expands on click", async () => {
  await openPhoto(everySection);

  for (const name of ["File", "EXIF", "GPS"]) {
    const region = screen.getByRole("region", { name });
    expect(within(region).getByRole("button", { name })).toHaveAttribute("aria-expanded", "true");
  }
  const makerNotes = screen.getByRole("region", { name: "Maker notes" });
  const toggle = within(makerNotes).getByRole("button", { name: "Maker notes" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(within(makerNotes).getByText("EOS R6")).not.toBeVisible();

  await userEvent.click(toggle);

  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(within(makerNotes).getByText("EOS R6")).toBeVisible();
});

it("reveals a Field's exact Tag name when its label is hovered", async () => {
  await openPhoto(everySection);

  const label = screen.getByText("Exposure Time");
  await userEvent.hover(label);

  expect(label).toHaveAttribute("title", "ExposureTime");
  expect(screen.getByTitle("CanonModelID")).toHaveTextContent("Canon Model ID");
});

async function filterFields(text: string) {
  const box = screen.getByRole("searchbox", { name: /filter fields/i });
  await userEvent.clear(box);
  if (text) await userEvent.type(box, text);
}

it("filters Fields by label", async () => {
  await openPhoto(everySection);

  await filterFields("exposure");

  const exif = screen.getByRole("region", { name: "EXIF" });
  expect(within(exif).getByText("Exposure Time")).toBeVisible();
  expect(within(exif).queryByText("Make")).not.toBeInTheDocument();
});

it("filters Fields by Tag name", async () => {
  await openPhoto(everySection);

  // Only the Tag name "GPSLatitudeRef" has no space; its label is "GPS Latitude Ref".
  await filterFields("latituderef");

  expect(within(screen.getByRole("region", { name: "GPS" })).getByText("North")).toBeVisible();
  expect(screen.queryByText("Exposure Time")).not.toBeInTheDocument();
});

it("filters Fields by Raw value and by Display value", async () => {
  await openPhoto(everySection);

  await filterFields("canon");
  const exif = screen.getByRole("region", { name: "EXIF" });
  expect(within(exif).getByText("Make")).toBeVisible();
  expect(within(exif).queryByText("Exposure Time")).not.toBeInTheDocument();

  await filterFields("1/250");
  expect(within(exif).getByText("Exposure Time")).toBeVisible();
  expect(within(exif).queryByText("Make")).not.toBeInTheDocument();
});

it("hides Sections with no matching Fields while filtering", async () => {
  await openPhoto(everySection);

  await filterFields("1/250");

  expect(screen.getByRole("region", { name: "EXIF" })).toBeVisible();
  for (const name of ["File", "GPS", "Maker notes"]) {
    expect(screen.queryByRole("region", { name })).not.toBeInTheDocument();
  }
});

it("shows a match inside collapsed Maker notes", async () => {
  await openPhoto(everySection);
  const toggle = screen.getByRole("button", { name: "Maker notes" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");

  await filterFields("eos");

  const makerNotes = screen.getByRole("region", { name: "Maker notes" });
  expect(within(makerNotes).getByText("Canon Model ID")).toBeVisible();
  expect(within(makerNotes).getByText("EOS R6")).toBeVisible();
});

it("restores every Section's collapsed or expanded state when the filter is cleared", async () => {
  await openPhoto(everySection);
  await userEvent.click(screen.getByRole("button", { name: "GPS" }));

  await filterFields("eos");
  await filterFields("");

  for (const name of ["File", "EXIF"]) {
    expect(screen.getByRole("button", { name })).toHaveAttribute("aria-expanded", "true");
  }
  for (const name of ["GPS", "Maker notes"]) {
    expect(screen.getByRole("button", { name })).toHaveAttribute("aria-expanded", "false");
  }
  expect(screen.getByText("North")).not.toBeVisible();
  expect(screen.getByText("EOS R6")).not.toBeVisible();
  expect(screen.getByText("Make")).toBeVisible();
  expect(screen.getByText("Exposure Time")).toBeVisible();
});

it("shows Warnings first in the panel, above the Summary and Sections", async () => {
  const warned: Analysis = {
    ...analysis,
    warnings: [
      { kind: "no-date-taken", message: "This Photo has no Date taken." },
      { kind: "damaged-file", message: "This Photo looks damaged." },
    ],
  };
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(warned));
  render(<App />);

  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);

  const warnings = await screen.findByRole("region", { name: /warnings/i });
  expect(within(warnings).getByText("This Photo has no Date taken.")).toBeInTheDocument();
  expect(within(warnings).getByText("This Photo looks damaged.")).toBeInTheDocument();
  const [first, ...rest] = screen.getAllByRole("region");
  expect(first).toBe(warnings);
  expect(rest.length).toBeGreaterThan(0);
});

it("shows no Warnings area when a Photo has no Warnings", async () => {
  render(<App />);

  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);

  await screen.findByRole("region", { name: "EXIF" });
  expect(screen.queryByRole("region", { name: /warnings/i })).not.toBeInTheDocument();
});

it("shows the server's converted preview for a HEIC Photo", async () => {
  const heic: Analysis = {
    ...analysis,
    photo: { name: "IMG_0001.HEIC", sizeBytes: 924, mimeType: "image/heic" },
    preview: { kind: "converted", mimeType: "image/jpeg", base64: "/9j/AAAA" },
  };
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(heic));
  render(<App />);

  await userEvent.upload(
    screen.getByLabelText(/choose a photo/i),
    new File(["heic bytes"], "IMG_0001.HEIC", { type: "image/heic" }),
  );

  expect(await screen.findByRole("img", { name: "IMG_0001.HEIC" })).toHaveAttribute(
    "src",
    "data:image/jpeg;base64,/9j/AAAA",
  );
});

it("shows a placeholder instead of a preview when a Photo has no preview", async () => {
  const raw: Analysis = {
    ...analysis,
    photo: { name: "IMG_0001.DNG", sizeBytes: 840, mimeType: "image/x-adobe-dng" },
    preview: { kind: "none" },
  };
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(raw));
  render(<App />);

  await userEvent.upload(
    screen.getByLabelText(/choose a photo/i),
    new File(["raw bytes"], "IMG_0001.DNG", { type: "image/x-adobe-dng" }),
  );

  expect(await screen.findByText(/no preview/i)).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "EXIF" })).toBeInTheDocument();
});

const withFaces: Analysis = {
  ...analysis,
  faces: [
    { id: "face-1", box: { x: 0.1, y: 0.2, width: 0.15, height: 0.25 } },
    { id: "face-2", box: { x: 0.6, y: 0.3, width: 0.1, height: 0.2 } },
  ],
};

async function openPhotoWithFaces() {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(withFaces));
  render(<App />);
  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);
  await screen.findByRole("img", { name: "beach.jpg" });
}

it("draws a numbered box over the preview for each Face, placed by its fractions of the Photo", async () => {
  await openPhotoWithFaces();

  const boxes = within(screen.getByRole("list", { name: "Face boxes" })).getAllByRole("listitem");
  expect(boxes.map((box) => box.textContent)).toEqual(["1", "2"]);
  expect(boxes[0]).toHaveStyle({ left: "10%", top: "20%", width: "15%", height: "25%" });
  expect(boxes[1]).toHaveStyle({ left: "60%", top: "30%", width: "10%", height: "20%" });
});

it("heads the panel's Faces with their count, above the Summary", async () => {
  await openPhotoWithFaces();

  const faces = screen.getByRole("region", { name: "Faces (2)" });
  const summary = screen.getByRole("region", { name: "Summary" });
  expect(faces.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("hides the Face boxes when Show boxes is turned off, and shows them again when it is turned on", async () => {
  await openPhotoWithFaces();
  const toggle = within(screen.getByRole("region", { name: "Faces (2)" })).getByRole("checkbox", { name: "Show boxes" });
  expect(toggle).toBeChecked();

  await userEvent.click(toggle);

  expect(screen.queryByRole("list", { name: "Face boxes" })).not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: "beach.jpg" })).toBeInTheDocument();

  await userEvent.click(toggle);

  expect(screen.getByRole("list", { name: "Face boxes" })).toBeInTheDocument();
});

it("shows no Faces heading, toggle or boxes when a Photo has no Faces", async () => {
  render(<App />);

  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);

  await screen.findByRole("region", { name: "Summary" });
  expect(screen.queryByRole("region", { name: /faces/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: "Show boxes" })).not.toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Face boxes" })).not.toBeInTheDocument();
});

const withFacesAndAnimals: Analysis = {
  ...withFaces,
  animals: [
    { id: "animal-a", species: "dog", box: { x: 0.3, y: 0.4, width: 0.25, height: 0.5 } },
    { id: "animal-b", species: "cat", box: { x: 0.7, y: 0.5, width: 0.2, height: 0.3 } },
  ],
};

async function open(opened: Analysis) {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json(opened));
  render(<App />);
  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);
  await screen.findByRole("img", { name: "beach.jpg" });
}

it("draws a box over the preview for each Animal, labelled with its species and styled apart from Face boxes", async () => {
  await open(withFacesAndAnimals);

  const boxes = within(screen.getByRole("list", { name: "Animal boxes" })).getAllByRole("listitem");
  expect(boxes.map((box) => box.textContent)).toEqual(["dog", "cat"]);
  expect(boxes[0]).toHaveStyle({ left: "30%", top: "40%", width: "25%", height: "50%" });
  expect(boxes[1]).toHaveStyle({ left: "70%", top: "50%", width: "20%", height: "30%" });
  const faceBox = within(screen.getByRole("list", { name: "Face boxes" })).getAllByRole("listitem")[0]!;
  expect(boxes[0]!.className).not.toBe(faceBox.className);
});

it("heads the Animals with their count beside the Faces, above the Summary", async () => {
  await open(withFacesAndAnimals);

  const faces = screen.getByRole("region", { name: "Faces (2)" });
  const pets = screen.getByRole("region", { name: "Pets (2)" });
  const summary = screen.getByRole("region", { name: "Summary" });
  expect(faces.compareDocumentPosition(pets) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(pets.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("hides Face and Animal boxes alike when Show boxes is turned off", async () => {
  await open(withFacesAndAnimals);
  expect(screen.getAllByRole("checkbox", { name: "Show boxes" })).toHaveLength(1);

  await userEvent.click(screen.getByRole("checkbox", { name: "Show boxes" }));

  expect(screen.queryByRole("list", { name: "Face boxes" })).not.toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Animal boxes" })).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("checkbox", { name: "Show boxes" }));

  expect(screen.getByRole("list", { name: "Face boxes" })).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Animal boxes" })).toBeInTheDocument();
});

it("offers Show boxes under the Pets heading when a Photo has Animals but no Faces", async () => {
  await open({ ...withFacesAndAnimals, faces: [] });

  expect(screen.queryByRole("region", { name: /faces/i })).not.toBeInTheDocument();
  const toggle = within(screen.getByRole("region", { name: "Pets (2)" })).getByRole("checkbox", { name: "Show boxes" });

  await userEvent.click(toggle);

  expect(screen.queryByRole("list", { name: "Animal boxes" })).not.toBeInTheDocument();
});

it("shows nothing about pets when a Photo has no Animals", async () => {
  await openPhotoWithFaces();

  expect(screen.getByRole("region", { name: "Faces (2)" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: /pets/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Animal boxes" })).not.toBeInTheDocument();
});

/**
 * Stands in for the server's face and pet routes, keeping People and Pets in
 * memory, and records every request so tests can check what the viewer sent.
 */
function fakeFaceServer(opened: Analysis, people: PersonSummary[] = [], pets: PetSummary[] = []) {
  const requests: { method: string; url: string; body?: unknown }[] = [];
  let nextId = 1;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, string>) : undefined;
    requests.push({ method, url, body });
    const route = (pattern: RegExp, verb: string) => (method === verb ? url.match(pattern) : null);
    let match;
    if (url === "/api/analyze") return Response.json(opened);
    if (route(/^\/api\/people$/, "GET")) return Response.json({ people });
    if (route(/^\/api\/pets$/, "GET")) return Response.json({ pets });
    if ((match = route(/^\/api\/animals\/(.+)\/pet$/, "PUT"))) {
      let pet = pets.find((p) => p.name.toLowerCase() === body!["name"]!.toLowerCase());
      if (!pet) pets = [...pets, (pet = { id: `pet-${nextId++}`, name: body!["name"]!, animalCount: 0 })];
      pet.animalCount++;
      return Response.json({ id: pet.id, name: pet.name });
    }
    if (route(/^\/api\/animals\/(.+)\/not-a-pet$/, "POST")) return new Response(null, { status: 204 });
    if ((match = route(/^\/api\/faces\/(.+)\/person$/, "PUT"))) {
      let person = people.find((p) => p.name.toLowerCase() === body!["name"]!.toLowerCase());
      if (!person) people = [...people, (person = { id: `person-${nextId++}`, name: body!["name"]!, faceCount: 0 })];
      person.faceCount++;
      return Response.json({ id: person.id, name: person.name });
    }
    if (route(/^\/api\/faces\/(.+)\/not-a-face$/, "POST")) return new Response(null, { status: 204 });
    if ((match = route(/^\/api\/faces\/(.+)\/suggestion\/confirm$/, "POST"))) {
      const person = people.find((p) => p.id === body!["personId"])!;
      person.faceCount++;
      return Response.json({ id: person.id, name: person.name });
    }
    if ((match = route(/^\/api\/faces\/(.+)\/suggestion\/reject$/, "POST"))) {
      const { suggestion: _rejected, ...face } = opened.faces.find((f) => f.id === match![1])!;
      return Response.json(face);
    }
    if ((match = route(/^\/api\/people\/([^/]+)$/, "PATCH"))) {
      people = people.map((p) => (p.id === match![1] ? { ...p, name: body!["name"]! } : p));
      return Response.json({ id: match[1], name: body!["name"] });
    }
    if ((match = route(/^\/api\/people\/([^/]+)\/merge$/, "POST"))) {
      const from = people.find((p) => p.id === match![1])!;
      people = people.filter((p) => p !== from).map((p) => (p.id === body!["into"] ? { ...p, faceCount: p.faceCount + from.faceCount } : p));
      return new Response(null, { status: 204 });
    }
    if ((match = route(/^\/api\/people\/([^/]+)$/, "DELETE"))) {
      people = people.filter((p) => p.id !== match![1]);
      return new Response(null, { status: 204 });
    }
    if ((match = route(/^\/api\/pets\/([^/]+)$/, "PATCH"))) {
      pets = pets.map((p) => (p.id === match![1] ? { ...p, name: body!["name"]! } : p));
      return Response.json({ id: match[1], name: body!["name"] });
    }
    if ((match = route(/^\/api\/pets\/([^/]+)\/merge$/, "POST"))) {
      const from = pets.find((p) => p.id === match![1])!;
      pets = pets.filter((p) => p !== from).map((p) => (p.id === body!["into"] ? { ...p, animalCount: p.animalCount + from.animalCount } : p));
      return new Response(null, { status: 204 });
    }
    if ((match = route(/^\/api\/pets\/([^/]+)$/, "DELETE"))) {
      pets = pets.filter((p) => p.id !== match![1]);
      return new Response(null, { status: 204 });
    }
    if (route(/^\/api\/face-and-pet-data$/, "DELETE")) {
      people = [];
      pets = [];
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return { requests };
}

const crew: Analysis = {
  ...analysis,
  faces: [
    { id: "face-a", box: { x: 0.2, y: 0.3, width: 0.1, height: 0.15 }, person: { id: "neil", name: "Neil" } },
    { id: "face-b", box: { x: 0.45, y: 0.15, width: 0.1, height: 0.15 } },
    { id: "face-c", box: { x: 0.7, y: 0.3, width: 0.1, height: 0.15 } },
  ],
};

const crewPeople = (): PersonSummary[] => [
  { id: "buzz", name: "Buzz Aldrin", faceCount: 3 },
  { id: "mike", name: "Michael Collins", faceCount: 1 },
  { id: "neil", name: "Neil", faceCount: 2 },
];

async function openCrew() {
  render(<App />);
  await userEvent.upload(screen.getByLabelText(/choose a photo/i), photo);
  await screen.findByRole("img", { name: "beach.jpg" });
}

const faceBox = (name: string | RegExp) =>
  within(screen.getByRole("list", { name: "Face boxes" })).getByRole("button", { name });

it("labels each Face box with its Person's name", async () => {
  fakeFaceServer(crew, crewPeople());
  await openCrew();

  expect(faceBox("Face 1: Neil")).toHaveTextContent("Neil");
  expect(faceBox("Face 2")).toBeInTheDocument();
});

it("names a Face by clicking its box and picking an existing Person from the autocomplete", async () => {
  const server = fakeFaceServer(crew, crewPeople());
  await openCrew();

  await userEvent.click(faceBox("Face 3"));
  const form = screen.getByRole("form", { name: "Name Face 3" });
  await userEvent.type(within(form).getByRole("combobox", { name: "Name" }), "IN");
  const options = within(form).getByRole("listbox", { name: "People" });
  // Matches anywhere in the name, ignoring case.
  expect(within(options).getAllByRole("option").map((o) => o.textContent)).toEqual(["Buzz Aldrin", "Michael Collins"]);
  await userEvent.click(within(options).getByRole("option", { name: "Buzz Aldrin" }));

  expect(server.requests).toContainEqual({ method: "PUT", url: "/api/faces/face-c/person", body: { name: "Buzz Aldrin" } });
  expect(await screen.findByRole("button", { name: "Face 3: Buzz Aldrin" })).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Name Face 3" })).not.toBeInTheDocument();
});

it("names a Face with a new name, which creates a Person", async () => {
  const server = fakeFaceServer(crew, crewPeople());
  await openCrew();

  await userEvent.click(faceBox("Face 2"));
  await userEvent.type(screen.getByRole("combobox", { name: "Name" }), "Mike{Enter}");

  expect(server.requests).toContainEqual({ method: "PUT", url: "/api/faces/face-b/person", body: { name: "Mike" } });
  expect(await screen.findByRole("button", { name: "Face 2: Mike" })).toBeInTheDocument();
});

it("starts the name field with the Face's current name", async () => {
  fakeFaceServer(crew, crewPeople());
  await openCrew();

  await userEvent.click(faceBox("Face 1: Neil"));

  expect(screen.getByRole("combobox", { name: "Name" })).toHaveValue("Neil");
});

it('removes a box marked "Not a face" and renumbers the rest', async () => {
  const server = fakeFaceServer(crew, crewPeople());
  await openCrew();

  await userEvent.click(faceBox("Face 2"));
  await userEvent.click(screen.getByRole("button", { name: "Not a face" }));

  expect(server.requests).toContainEqual({ method: "POST", url: "/api/faces/face-b/not-a-face", body: undefined });
  await screen.findByRole("region", { name: "Faces (2)" });
  const boxes = within(screen.getByRole("list", { name: "Face boxes" })).getAllByRole("button");
  expect(boxes.map((box) => box.getAttribute("aria-label"))).toEqual(["Face 1: Neil", "Face 2"]);
});

it("shows the server's message when a Face can no longer be named", async () => {
  fakeFaceServer(crew, crewPeople());
  await openCrew();
  vi.mocked(fetch).mockImplementation(async (input) =>
    String(input) === "/api/people"
      ? Response.json({ people: [] })
      : Response.json({ error: { message: "This Face is no longer stored. Open the Photo again." } }, { status: 404 }),
  );

  await userEvent.click(faceBox("Face 2"));
  await userEvent.type(screen.getByRole("combobox", { name: "Name" }), "Mike{Enter}");

  expect(await screen.findByRole("alert")).toHaveTextContent("This Face is no longer stored. Open the Photo again.");
  expect(faceBox("Face 2")).toBeInTheDocument();
});

async function openPeoplePanel() {
  await userEvent.click(screen.getByRole("button", { name: "People and pets" }));
  return screen.findByRole("region", { name: "People and pets" });
}

const personRow = (panel: HTMLElement, name: string) =>
  within(within(panel).getByRole("list", { name: "People" }))
    .getAllByRole("listitem")
    .find((row) => within(row).queryByText(name, { selector: ".name-row-name" }))!;

const petRow = (panel: HTMLElement, name: string) =>
  within(within(panel).getByRole("list", { name: "Pets" }))
    .getAllByRole("listitem")
    .find((row) => within(row).queryByText(name, { selector: ".name-row-name" }))!;

it("lists People with their Face counts in the People and pets panel, even before a Photo is opened", async () => {
  fakeFaceServer(crew, crewPeople());
  render(<App />);

  const panel = await openPeoplePanel();

  expect(await within(panel).findByText("Buzz Aldrin")).toBeInTheDocument();
  expect(within(personRow(panel, "Buzz Aldrin")).getByText("3 Faces")).toBeInTheDocument();
  expect(within(personRow(panel, "Michael Collins")).getByText("1 Face")).toBeInTheDocument();
});

it("renames a Person, renaming their Faces in the opened Photo", async () => {
  const server = fakeFaceServer(crew, crewPeople());
  await openCrew();
  const panel = await openPeoplePanel();
  await within(panel).findByText("Neil");

  await userEvent.click(within(personRow(panel, "Neil")).getByRole("button", { name: "Rename Neil" }));
  const field = within(panel).getByRole("textbox", { name: "New name for Neil" });
  await userEvent.clear(field);
  await userEvent.type(field, "Neil Armstrong{Enter}");

  expect(server.requests).toContainEqual({ method: "PATCH", url: "/api/people/neil", body: { name: "Neil Armstrong" } });
  expect(await screen.findByRole("button", { name: "Face 1: Neil Armstrong" })).toBeInTheDocument();
  expect(await within(panel).findByText("Neil Armstrong")).toBeInTheDocument();
});

it("merges one Person into another after a confirmation", async () => {
  const server = fakeFaceServer(crew, crewPeople());
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await openCrew();
  const panel = await openPeoplePanel();
  await within(panel).findByText("Neil");

  await userEvent.click(within(personRow(panel, "Neil")).getByRole("button", { name: "Merge Neil" }));
  await userEvent.selectOptions(within(panel).getByRole("combobox", { name: "Merge Neil into" }), "Buzz Aldrin");
  await userEvent.click(within(panel).getByRole("button", { name: "Merge" }));

  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Merge Neil into Buzz Aldrin?"));
  expect(server.requests).toContainEqual({ method: "POST", url: "/api/people/neil/merge", body: { into: "buzz" } });
  expect(await screen.findByRole("button", { name: "Face 1: Buzz Aldrin" })).toBeInTheDocument();
  await waitFor(() => expect(within(personRow(panel, "Buzz Aldrin")).getByText("5 Faces")).toBeInTheDocument());
  expect(within(panel).queryByText("Neil", { selector: ".name-row-name" })).not.toBeInTheDocument();
});

it("deletes a Person after a confirmation, leaving their Faces unnamed, and does nothing when it is declined", async () => {
  const server = fakeFaceServer(crew, crewPeople());
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  await openCrew();
  const panel = await openPeoplePanel();
  await within(panel).findByText("Neil");
  const deleteNeil = () => userEvent.click(within(personRow(panel, "Neil")).getByRole("button", { name: "Delete Neil" }));

  await deleteNeil();
  expect(server.requests.some((r) => r.method === "DELETE")).toBe(false);

  await deleteNeil();
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining("Delete Neil?"));
  expect(server.requests).toContainEqual({ method: "DELETE", url: "/api/people/neil", body: undefined });
  expect(await screen.findByRole("button", { name: "Face 1" })).toBeInTheDocument();
  await waitFor(() => expect(within(panel).queryByText("Neil", { selector: ".name-row-name" })).not.toBeInTheDocument());
});

it('deletes all face and pet data after a confirmation, emptying the People and pets panel and unnaming the Animals', async () => {
  const server = fakeFaceServer(crewWithPets, crewPeople(), [{ id: "rex", name: "Rex", animalCount: 1 }]);
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await openCrew();
  const panel = await openPeoplePanel();
  await within(panel).findByText("Neil");

  await userEvent.click(within(panel).getByRole("button", { name: "Delete all face and pet data" }));

  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Delete all face and pet data?"));
  expect(server.requests).toContainEqual({ method: "DELETE", url: "/api/face-and-pet-data", body: undefined });
  expect(await within(panel).findByText("No one has been named yet.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Face 1" })).toBeInTheDocument();
  expect(animalBox("Animal 1: dog")).not.toHaveTextContent("Rex");
});

/** The crew with Face 2 suggested as Michael Collins and Face 3 in a Stranger. */
const crewWithSuggestion: Analysis = {
  ...crew,
  faces: [
    crew.faces[0]!,
    { ...crew.faces[1]!, suggestion: { id: "mike", name: "Michael Collins" } },
    { ...crew.faces[2]!, stranger: { label: "Unknown 4", photoCount: 7 } },
  ],
};

it("shows a Suggestion on its Face's box, and ✓ names the Face", async () => {
  const server = fakeFaceServer(crewWithSuggestion, crewPeople());
  await openCrew();
  expect(faceBox("Face 2: Michael Collins? (suggested)")).toHaveTextContent("Michael Collins?");

  await userEvent.click(screen.getByRole("button", { name: "✓ Face 2 is Michael Collins" }));

  expect(server.requests).toContainEqual({
    method: "POST",
    url: "/api/faces/face-b/suggestion/confirm",
    body: { personId: "mike" },
  });
  expect(await screen.findByRole("button", { name: "Face 2: Michael Collins" })).toHaveTextContent("Michael Collins");
  expect(screen.queryByRole("button", { name: /✓/ })).not.toBeInTheDocument();
});

it("✕ rejects a Suggestion, leaving the Face unnamed", async () => {
  const server = fakeFaceServer(crewWithSuggestion, crewPeople());
  await openCrew();

  await userEvent.click(screen.getByRole("button", { name: "✕ Face 2 is not Michael Collins" }));

  expect(server.requests).toContainEqual({
    method: "POST",
    url: "/api/faces/face-b/suggestion/reject",
    body: { personId: "mike" },
  });
  expect(await screen.findByRole("button", { name: "Face 2" })).not.toHaveTextContent("Michael Collins");
  expect(screen.queryByRole("button", { name: /✕/ })).not.toBeInTheDocument();
});

it("labels a Face in a Stranger with the Stranger and how many Photos it spans", async () => {
  fakeFaceServer(crewWithSuggestion, crewPeople());
  await openCrew();

  expect(faceBox("Face 3: Unknown 4, in 7 Photos")).toHaveTextContent("Unknown 4, in 7 Photos");
});

it("naming a Face drops the same Suggestion from the Photo's other Faces", async () => {
  fakeFaceServer(crewWithSuggestion, crewPeople());
  await openCrew();

  await userEvent.click(faceBox("Face 3: Unknown 4, in 7 Photos"));
  await userEvent.type(screen.getByRole("combobox", { name: "Name" }), "Michael Collins{Enter}");

  expect(await screen.findByRole("button", { name: "Face 3: Michael Collins" })).toBeInTheDocument();
  expect(faceBox("Face 2")).not.toHaveTextContent("Michael Collins");
});

/** The crew with a dog named Rex and an unnamed cat beside them. */
const crewWithPets: Analysis = {
  ...crew,
  animals: [
    { id: "animal-a", species: "dog", box: { x: 0.3, y: 0.6, width: 0.25, height: 0.3 }, pet: { id: "rex", name: "Rex" } },
    { id: "animal-b", species: "cat", box: { x: 0.7, y: 0.6, width: 0.2, height: 0.3 } },
  ],
};

const crewPets = (): PetSummary[] => [
  { id: "rex", name: "Rex", animalCount: 4 },
  { id: "maxi", name: "Maxine", animalCount: 2 },
];

const animalBox = (name: string | RegExp) =>
  within(screen.getByRole("list", { name: "Animal boxes" })).getByRole("button", { name });

it("labels each Animal box with its species, and its Pet's name once named", async () => {
  fakeFaceServer(crewWithPets, crewPeople(), crewPets());
  await openCrew();

  expect(animalBox("Animal 1: Rex (dog)")).toHaveTextContent("Rex");
  expect(animalBox("Animal 1: Rex (dog)")).toHaveTextContent("dog");
  expect(animalBox("Animal 2: cat")).toHaveTextContent("cat");
});

it("names an Animal by clicking its box, with names autocompleting from Pets only", async () => {
  // Max is a Person, Maxine a Pet: only Maxine is offered for an Animal.
  const server = fakeFaceServer(crewWithPets, [...crewPeople(), { id: "max", name: "Max", faceCount: 1 }], crewPets());
  await openCrew();

  await userEvent.click(animalBox("Animal 2: cat"));
  const form = screen.getByRole("form", { name: "Name Animal 2" });
  await userEvent.type(within(form).getByRole("combobox", { name: "Name" }), "max");
  const options = within(form).getByRole("listbox", { name: "Pets" });
  expect(within(options).getAllByRole("option").map((o) => o.textContent)).toEqual(["Maxine"]);
  await userEvent.click(within(options).getByRole("option", { name: "Maxine" }));

  expect(server.requests).toContainEqual({ method: "PUT", url: "/api/animals/animal-b/pet", body: { name: "Maxine" } });
  expect(await screen.findByRole("button", { name: "Animal 2: Maxine (cat)" })).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Name Animal 2" })).not.toBeInTheDocument();
});

it("names an Animal with a new name, which creates a Pet", async () => {
  const server = fakeFaceServer(crewWithPets, crewPeople(), crewPets());
  await openCrew();

  await userEvent.click(animalBox("Animal 2: cat"));
  await userEvent.type(screen.getByRole("combobox", { name: "Name" }), "Tom{Enter}");

  expect(server.requests).toContainEqual({ method: "PUT", url: "/api/animals/animal-b/pet", body: { name: "Tom" } });
  expect(await screen.findByRole("button", { name: "Animal 2: Tom (cat)" })).toBeInTheDocument();
});

it("never offers a Pet's name for a Face", async () => {
  fakeFaceServer(crewWithPets, crewPeople(), crewPets());
  await openCrew();

  await userEvent.click(faceBox("Face 2"));
  await userEvent.type(screen.getByRole("combobox", { name: "Name" }), "Max");

  expect(screen.queryByRole("option", { name: "Maxine" })).not.toBeInTheDocument();
});

it("starts an Animal's name field with its Pet's name", async () => {
  fakeFaceServer(crewWithPets, crewPeople(), crewPets());
  await openCrew();

  await userEvent.click(animalBox("Animal 1: Rex (dog)"));

  expect(screen.getByRole("combobox", { name: "Name" })).toHaveValue("Rex");
});

it('removes an Animal box marked "Not a pet" and renumbers the rest', async () => {
  const server = fakeFaceServer(crewWithPets, crewPeople(), crewPets());
  await openCrew();

  await userEvent.click(animalBox("Animal 1: Rex (dog)"));
  await userEvent.click(screen.getByRole("button", { name: "Not a pet" }));

  expect(server.requests).toContainEqual({ method: "POST", url: "/api/animals/animal-a/not-a-pet", body: undefined });
  await screen.findByRole("region", { name: "Pets (1)" });
  const boxes = within(screen.getByRole("list", { name: "Animal boxes" })).getAllByRole("button");
  expect(boxes.map((box) => box.getAttribute("aria-label"))).toEqual(["Animal 1: cat"]);
});

it("shows the server's message when an Animal can no longer be named", async () => {
  fakeFaceServer(crewWithPets, crewPeople(), crewPets());
  await openCrew();
  vi.mocked(fetch).mockImplementation(async (input) =>
    String(input) === "/api/pets"
      ? Response.json({ pets: [] })
      : Response.json({ error: { message: "This Animal is no longer stored. Open the Photo again." } }, { status: 404 }),
  );

  await userEvent.click(animalBox("Animal 2: cat"));
  await userEvent.type(screen.getByRole("combobox", { name: "Name" }), "Tom{Enter}");

  expect(await screen.findByRole("alert")).toHaveTextContent("This Animal is no longer stored. Open the Photo again.");
  expect(animalBox("Animal 2: cat")).toBeInTheDocument();
});

it("lists Pets with their Animal counts in their own section of the People and pets panel, showing no Photos", async () => {
  fakeFaceServer(crew, crewPeople(), crewPets());
  render(<App />);

  const panel = await openPeoplePanel();

  expect(within(panel).getByRole("heading", { name: "People and pets" })).toBeInTheDocument();
  const pets = within(panel).getByRole("region", { name: "Pets" });
  expect(await within(pets).findByText("Rex")).toBeInTheDocument();
  expect(within(petRow(panel, "Rex")).getByText("4 Animals")).toBeInTheDocument();
  expect(within(petRow(panel, "Maxine")).getByText("2 Animals")).toBeInTheDocument();
  expect(within(within(panel).getByRole("region", { name: "People" })).getByText("Buzz Aldrin")).toBeInTheDocument();
  expect(within(panel).queryByRole("img")).not.toBeInTheDocument();
});

it("renames a Pet, renaming its Animals in the opened Photo and leaving Faces alone", async () => {
  // Rex the dog and Rex the Person share an id here only to show that a Pet's change never reaches a Face.
  const server = fakeFaceServer(
    { ...crewWithPets, faces: [{ ...crew.faces[0]!, person: { id: "rex", name: "Rex" } }] },
    [{ id: "rex", name: "Rex", faceCount: 1 }],
    crewPets(),
  );
  await openCrew();
  const panel = await openPeoplePanel();
  await within(panel).findByText("Maxine");

  await userEvent.click(within(petRow(panel, "Rex")).getByRole("button", { name: "Rename Rex" }));
  const field = within(panel).getByRole("textbox", { name: "New name for Rex" });
  await userEvent.clear(field);
  await userEvent.type(field, "Baron{Enter}");

  expect(server.requests).toContainEqual({ method: "PATCH", url: "/api/pets/rex", body: { name: "Baron" } });
  expect(await screen.findByRole("button", { name: "Animal 1: Baron (dog)" })).toBeInTheDocument();
  expect(faceBox("Face 1: Rex")).toBeInTheDocument();
  expect(await within(petRow(panel, "Baron")).findByText("4 Animals")).toBeInTheDocument();
});

it("merges one Pet into another Pet only, after a confirmation", async () => {
  const server = fakeFaceServer(crewWithPets, crewPeople(), crewPets());
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await openCrew();
  const panel = await openPeoplePanel();
  await within(panel).findByText("Maxine");

  await userEvent.click(within(petRow(panel, "Rex")).getByRole("button", { name: "Merge Rex" }));
  const into = within(panel).getByRole("combobox", { name: "Merge Rex into" });
  // Only Pets are offered: no Person.
  expect(within(into).getAllByRole("option").map((o) => o.textContent)).toEqual(["Maxine"]);
  await userEvent.click(within(panel).getByRole("button", { name: "Merge" }));

  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Merge Rex into Maxine?"));
  expect(server.requests).toContainEqual({ method: "POST", url: "/api/pets/rex/merge", body: { into: "maxi" } });
  expect(await screen.findByRole("button", { name: "Animal 1: Maxine (dog)" })).toBeInTheDocument();
  await waitFor(() => expect(within(petRow(panel, "Maxine")).getByText("6 Animals")).toBeInTheDocument());
  expect(within(panel).queryByText("Rex", { selector: ".name-row-name" })).not.toBeInTheDocument();
});

it("deletes a Pet after a confirmation, leaving its Animals unnamed", async () => {
  const server = fakeFaceServer(crewWithPets, crewPeople(), crewPets());
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  await openCrew();
  const panel = await openPeoplePanel();
  await within(panel).findByText("Maxine");

  await userEvent.click(within(petRow(panel, "Rex")).getByRole("button", { name: "Delete Rex" }));

  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Delete Rex?"));
  expect(server.requests).toContainEqual({ method: "DELETE", url: "/api/pets/rex", body: undefined });
  expect(await screen.findByRole("button", { name: "Animal 1: dog" })).toBeInTheDocument();
  await waitFor(() => expect(within(panel).queryByText("Rex", { selector: ".name-row-name" })).not.toBeInTheDocument());
  expect(within(panel).getByText("Buzz Aldrin")).toBeInTheDocument();
});

it("shows the server's message when a Pet can't be renamed", async () => {
  fakeFaceServer(crewWithPets, crewPeople(), crewPets());
  await openCrew();
  const panel = await openPeoplePanel();
  await within(panel).findByText("Maxine");
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ error: { message: "A Pet is already called Maxine. Merge them instead." } }, { status: 409 }),
  );

  await userEvent.click(within(petRow(panel, "Rex")).getByRole("button", { name: "Rename Rex" }));
  const field = within(panel).getByRole("textbox", { name: "New name for Rex" });
  await userEvent.clear(field);
  await userEvent.type(field, "maxine{Enter}");

  expect(await within(panel).findByRole("alert")).toHaveTextContent("A Pet is already called Maxine. Merge them instead.");
  expect(animalBox("Animal 1: Rex (dog)")).toBeInTheDocument();
});
