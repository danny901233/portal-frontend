// ffmpeg-static ships a binary and no type declarations. Its default export is the absolute
// path to that binary, or null on a platform it has no build for.
declare module 'ffmpeg-static' {
  const ffmpegPath: string | null;
  export default ffmpegPath;
}
