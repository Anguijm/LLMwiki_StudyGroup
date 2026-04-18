import type { VoyageClient } from '../voyage';

export interface VoyageMockOptions {
  embed?: (text: string) => Promise<number[]>;
}

export function makeVoyageMock(opts: VoyageMockOptions = {}): VoyageClient {
  return {
    embed: opts.embed ?? (async () => new Array(1024).fill(0.1)),
  };
}
