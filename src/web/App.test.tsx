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
