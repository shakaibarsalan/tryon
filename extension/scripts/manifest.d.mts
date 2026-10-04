export declare const ICON_SIZES: number[];
export declare function apiOrigin(apiUrl: string): string;
export declare function buildManifest(o: {
  brand: { name: string; shortName?: string; description: string };
  version: string;
  apiUrl: string;
}): Record<string, any>;
