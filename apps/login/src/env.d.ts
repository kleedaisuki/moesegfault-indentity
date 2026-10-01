/** Immutable hosted build revision; never sourced from browser input. */
declare const __LOGIN_BUILD_REVISION__: string;

interface ImportMetaEnv {
  readonly VITE_IDENTITY_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
