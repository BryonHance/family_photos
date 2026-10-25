import { ExifTool } from "exiftool-vendored";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFaceDetector, type FaceDetector } from "./faces/detector.ts";
import { modelsDir, openFaceApi, type FaceApi } from "./testing/face-api.ts";

// These tests run the real buffalo_sc models: fetch them with `pixi run models`.
// crew.jpg shows three Faces, left to right: Armstrong, Collins, Aldrin.
// crew-rotated.jpg is another Photo (other bytes) of the same three, upright the same.
// armstrong-twice.jpg shows Armstrong twice: cropped from crew.jpg, then beside it mirrored.

let exiftool: ExifTool;
let faceDetector: FaceDetector;
let api: FaceApi;

beforeAll(async () => {
  exiftool = new ExifTool();
  faceDetector = await loadFaceDetector(modelsDir);
});

afterAll(async () => {
  await exiftool.end();
});

beforeEach(async () => {
  api = await openFaceApi({ exiftool, faceDetector });
});

afterEach(async () => {
  await api.close();
});

const strangerLabels = (faces: { stranger?: { label: string; photoCount: number } }[]) =>
  faces.map((face) => face.stranger && `${face.stranger.label}, in ${face.stranger.photoCount} Photos`);

const suggestedNames =(faces: { suggestion?: { name: string } }[]) => faces.map((face) => face.suggestion?.name);

describe("Suggestions", () => {
  it("suggests the Person of a named Face for the same Face in another Photo", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");

    const faces = (await api.upload("crew-rotated.jpg")).faces;

    expect(faces[0]!.suggestion).toEqual(neil);
    expect(faces[0]!.person).toBeUndefined();
    expect(suggestedNames(faces)).toEqual(["Neil", undefined, undefined]);
  });

  it("confirming a Suggestion names the Face", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");
    const [suggested] = (await api.upload("crew-rotated.jpg")).faces;

    expect(await api.confirmSuggestion(suggested!.id, neil.id)).toEqual(neil);

    const [reopened] = (await api.upload("crew-rotated.jpg")).faces;
    expect(reopened!.person).toEqual(neil);
    expect(reopened!.suggestion).toBeUndefined();
    expect((await api.people()).map((p) => p.faceCount)).toEqual([2]);
  });

  it("a rejected Suggestion never returns, and ignoring one saves nothing", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");
    const [suggested] = (await api.upload("crew-rotated.jpg")).faces;
    const ignored = await api.upload("crew-rotated.jpg");
    expect(ignored.faces[0]!.suggestion).toEqual(neil);

    const afterRejecting = await api.rejectSuggestion(suggested!.id, neil.id);

    expect(afterRejecting.suggestion).toBeUndefined();
    expect(afterRejecting.person).toBeUndefined();
    const [reopened] = (await api.upload("crew-rotated.jpg")).faces;
    expect(reopened!.suggestion).toBeUndefined();
    expect(reopened!.person).toBeUndefined();
  });

  it("never suggests two Faces of one Photo as the same Person: the better match wins", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    await api.nameFace(armstrong!.id, "Neil");

    const twice = (await api.upload("armstrong-twice.jpg")).faces;

    // The left-hand Face is the crop as it was; the right-hand one is mirrored.
    expect(twice).toHaveLength(2);
    expect(suggestedNames(twice)).toEqual(["Neil", undefined]);
  });

  it("does not suggest a Person already named in the same Photo", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    await api.nameFace(armstrong!.id, "Neil");
    const [left, right] = (await api.upload("armstrong-twice.jpg")).faces;

    await api.nameFace(left!.id, "Neil");

    const [, reopenedRight] = (await api.upload("armstrong-twice.jpg")).faces;
    expect(reopenedRight!.id).toBe(right!.id);
    expect(reopenedRight!.suggestion).toBeUndefined();
  });

  it("refuses to confirm or reject for an unknown Face or Person", async () => {
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");
    const [suggested] = (await api.upload("crew-rotated.jpg")).faces;

    for (const verb of ["confirm", "reject"]) {
      expect((await api.call("POST", `/api/faces/no-such-face/suggestion/${verb}`, { personId: neil.id })).status).toBe(404);
      expect((await api.call("POST", `/api/faces/${suggested!.id}/suggestion/${verb}`, { personId: "nobody" })).status).toBe(404);
      expect((await api.call("POST", `/api/faces/${suggested!.id}/suggestion/${verb}`, {})).status).toBe(400);
    }
    expect((await api.upload("crew-rotated.jpg")).faces[0]!.suggestion).toEqual(neil);
  });
});

describe("Strangers", () => {
  it("labels unnamed look-alike Faces across two Photos alike, with how many Photos they span", async () => {
    const first = (await api.upload("crew.jpg")).faces;
    // A Stranger in a single Photo shows no label.
    expect(strangerLabels(first)).toEqual([undefined, undefined, undefined]);

    const second = (await api.upload("crew-rotated.jpg")).faces;

    const labels = strangerLabels(second);
    expect(labels).toEqual([
      expect.stringMatching(/^Unknown \d+, in 2 Photos$/),
      expect.stringMatching(/^Unknown \d+, in 2 Photos$/),
      expect.stringMatching(/^Unknown \d+, in 2 Photos$/),
    ]);
    expect(new Set(labels).size).toBe(3);
    expect(strangerLabels((await api.upload("crew.jpg")).faces)).toEqual(labels);
    expect(second.every((face) => face.person === undefined && face.suggestion === undefined)).toBe(true);
  });

  it("the Faces of a deleted Person join a Stranger again, under a number never used before", async () => {
    await api.upload("crew.jpg");
    const before = (await api.upload("crew-rotated.jpg")).faces;
    const usedLabels = before.map((face) => face.stranger!.label);
    const [armstrong] = (await api.upload("crew.jpg")).faces;
    const neil = await api.nameFace(armstrong!.id, "Neil");
    await api.confirmSuggestion(before[0]!.id, neil.id);

    await api.deletePerson(neil.id);

    const crew = (await api.upload("crew.jpg")).faces;
    const rotated = (await api.upload("crew-rotated.jpg")).faces;
    expect(crew[0]!.person).toBeUndefined();
    expect(crew[0]!.stranger).toEqual(rotated[0]!.stranger);
    expect(crew[0]!.stranger?.photoCount).toBe(2);
    expect(usedLabels).not.toContain(crew[0]!.stranger?.label);
    // The other two Strangers are untouched.
    expect(strangerLabels(rotated).slice(1)).toEqual(strangerLabels(before).slice(1));
  });

  it("a Stranger left with Faces in one Photo shows no label", async () => {
    const [, collins] = (await api.upload("crew.jpg")).faces;
    await api.upload("crew-rotated.jpg");

    await api.markNotAFace(collins!.id);

    expect(strangerLabels((await api.upload("crew-rotated.jpg")).faces)).toEqual([
      expect.stringMatching(/, in 2 Photos$/),
      undefined,
      expect.stringMatching(/, in 2 Photos$/),
    ]);
  });
});
