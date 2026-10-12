// Build-time constants injected by build.mjs (esbuild `define`). Always read them behind a
// `typeof` guard so the same modules also run under vitest, where they are not defined.
declare const __TRYON_API__: string;
declare const __TRYON_DEV__: boolean;
