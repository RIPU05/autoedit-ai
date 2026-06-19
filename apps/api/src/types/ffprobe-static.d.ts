// ffprobe-static ships no type declarations; minimal shim.
declare module 'ffprobe-static' {
  const ffprobe: { path: string };
  export default ffprobe;
}
