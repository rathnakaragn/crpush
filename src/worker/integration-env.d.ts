declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

declare module "*.sql?raw" {
  const content: string;
  export default content;
}

// Minimal typing for Vite's glob import used in integration-setup.ts
interface ImportMeta {
  glob(pattern: string, opts: { query: string; eager: true }): Record<string, { default: string }>;
}

declare module "*.html?raw" {
  const content: string;
  export default content;
}
