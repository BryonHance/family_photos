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

const suggestedNames = (faces: { suggestion?: { name: string } }[]) => faces.map((face) => face.suggestion?.name);

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
