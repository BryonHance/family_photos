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
