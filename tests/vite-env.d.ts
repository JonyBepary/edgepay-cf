/** vite `?raw` imports (used by tests/setup/migrations.ts to load SQL). */
declare module '*?raw' {
  const content: string;
  export default content;
}
