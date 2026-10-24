import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Analysis } from "../shared/analysis.ts";
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
};

const photo = new File(["jpeg bytes"], "beach.jpg", { type: "image/jpeg" });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(analysis)));
  URL.createObjectURL = vi.fn(() => "blob:beach");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
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

it("shows a placeholder instead of an image when a Photo has no preview", async () => {
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
