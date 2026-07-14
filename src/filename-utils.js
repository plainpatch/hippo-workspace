import { TextDecoder } from "node:util";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeMultipartFileName(fileName) {
  const value = String(fileName || "");
  if (!value || [...value].some((character) => character.codePointAt(0) > 0xff)) return value;

  const bytes = Buffer.from(value, "latin1");
  try {
    const decoded = utf8Decoder.decode(bytes);
    return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : value;
  } catch {
    return value;
  }
}
