import type { UploadContentType } from "./types.js";

/* A record keyed by every upload type rather than a set, so that a type the contract adds and this
   table lacks fails to compile instead of being refused at run time. */
const supported: Record<UploadContentType, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "image/gif": true,
  "video/mp4": true,
  "video/webm": true,
  "audio/mpeg": true,
  "audio/wav": true,
  "application/pdf": true,
  "application/msword": true,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
  "application/vnd.ms-excel": true,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "application/vnd.ms-powerpoint": true,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
  "application/vnd.apple.keynote": true,
  "application/vnd.apple.pages": true,
  "application/vnd.apple.numbers": true,
  "text/plain": true,
  "text/markdown": true,
};

// Large assets go through the direct-upload pipeline; the task JSON never carries a whole Base64
// payload.
export function decodeBase64Media(value: string, contentType?: UploadContentType) {
  let encoded = value;
  if (value.startsWith("data:")) {
    const separator = value.indexOf(",");
    const header = value.slice(0, separator);
    const match = /^data:([^;,]+);base64$/.exec(header);
    if (!match || separator < 0) throw new TypeError("expected a Base64 data URI");
    const declared = match[1] as UploadContentType;
    if (contentType && contentType !== declared)
      throw new TypeError("contentType does not match the data URI");
    contentType = declared;
    encoded = value.slice(separator + 1);
  }
  if (!contentType || !Object.hasOwn(supported, contentType))
    throw new TypeError("a supported contentType is required for raw Base64");
  // 90 MiB for audio, video and documents rather than 100: since 2026-09-12 reference assets no
  // longer go straight from the browser to object storage but through a Cloudflare Worker, whose
  // request body limit is 100 MB, and the server's MaxReferenceMediaBytes came down to 90 MiB to
  // match. Documents share that limit. Checking here first saves a long upload the server is
  // certain to reject.
  const maximum = contentType.startsWith("image/") ? 10 * 1024 * 1024 : 90 * 1024 * 1024;
  if (encoded.length > Math.ceil(maximum / 3) * 4)
    throw new TypeError("Base64 media exceeds the upload size limit");
  if (!encoded.length || encoded.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(encoded))
    throw new TypeError("invalid Base64 media");
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const length = encoded.length - padding;
  if ((padding && encoded.length % 4 !== 0) || (padding && encoded.indexOf("=") !== length))
    throw new TypeError("invalid Base64 padding");
  const tail = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(
    encoded[length - 1]!,
  );
  if ((length % 4 === 2 && (tail & 15) !== 0) || (length % 4 === 3 && (tail & 3) !== 0))
    throw new TypeError("invalid Base64 padding bits");
  const data = Buffer.from(encoded, "base64");
  if (
    !data.byteLength ||
    data.byteLength > maximum ||
    data.byteLength !== Math.floor((length * 3) / 4)
  )
    throw new TypeError("invalid Base64 media");
  return { data, contentType };
}
