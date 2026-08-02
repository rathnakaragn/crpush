declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

declare module "*.sql?raw" {
  const content: string;
  export default content;
}

declare module "*.html?raw" {
  const content: string;
  export default content;
}
