/**
 * Upright pixels held in memory, row by row, `channels` bytes per pixel: RGB
 * (3) or RGBA (4). Never written anywhere (ADR-0001, ADR-0002).
 */
export type Pixels<Channels extends 3 | 4 = 3 | 4> = {
  width: number;
  height: number;
  channels: Channels;
  data: Uint8Array | Uint8ClampedArray;
};
