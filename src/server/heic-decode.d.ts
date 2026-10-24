// heic-decode ships no types. Only the call the viewer makes is declared.
declare module "heic-decode" {
  export default function decode(input: {
    buffer: ArrayBufferLike | Uint8Array;
  }): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
}
