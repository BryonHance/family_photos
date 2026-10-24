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
