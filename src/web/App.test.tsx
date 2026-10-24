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
