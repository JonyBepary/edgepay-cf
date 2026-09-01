declare module '*?raw' {
  const content: string;
  export default content;
}
declare module 'node:fs' {
  const fs: unknown;
  export default fs;
}
declare module 'node:path' {
  const path: unknown;
  export default path;
}
