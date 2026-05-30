import type { MediaUnderstandingCapability } from "./types.js";

const MB = 1024 * 1024;

export const DEFAULT_MAX_CHARS = 500;
export const DEFAULT_MAX_CHARS_BY_CAPABILITY: Record<
  MediaUnderstandingCapability,
  number | undefined
> = {
  image: DEFAULT_MAX_CHARS,
  audio: undefined,
  video: DEFAULT_MAX_CHARS,
};
export const DEFAULT_MAX_BYTES: Record<MediaUnderstandingCapability, number> = {
  image: 20 * MB,
  audio: 40 * MB,
  video: 100 * MB,
};
export const DEFAULT_TIMEOUT_SECONDS: Record<MediaUnderstandingCapability, number> = {
  image: 180,
  audio: 180,
  video: 180,
};
export const DEFAULT_PROMPT: Record<MediaUnderstandingCapability, string> = {
  image: "Describe the image.",
  audio: "Transcribe the audio.",
  video: "Describe the video.",
};
export const DEFAULT_VIDEO_MAX_BASE64_BYTES = 70 * MB;
export const CLI_OUTPUT_MAX_BUFFER = 5 * MB;
export const DEFAULT_MEDIA_CONCURRENCY = 2;
export const MIN_AUDIO_FILE_BYTES = 1024;
