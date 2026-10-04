// Saving and preparing the person photo.
import { LIMITS } from "@tryon/shared";
import { savePhoto, type PersonPhoto } from "./db";
import { decodeBlob, encodeJpeg } from "./image";
import { checkPersonPhoto, type PhotoCheck } from "./image-math";
import { sendRuntime } from "./util";

export interface PreparedPhoto {
  photo?: PersonPhoto;
  check: PhotoCheck;
}

/** Decode, check and resize an uploaded photo. Nothing is saved when the check fails. */
export async function prepareUploadedPhoto(file: Blob): Promise<PreparedPhoto> {
  if (file.type && !/^image\//.test(file.type)) {
    return { check: { ok: false, errors: ["That file isn't an image."], warnings: [] } };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await decodeBlob(file);
  } catch {
    return { check: { ok: false, errors: ["We couldn't open that image. Try a JPEG or PNG photo."], warnings: [] } };
  }
  try {
    const check = checkPersonPhoto(bitmap.width, bitmap.height);
    if (!check.ok) return { check };
    const enc = await encodeJpeg(bitmap, LIMITS.personMaxSide, undefined, { quality: 0.9 });
    return {
      check,
      photo: { dataUrl: enc.dataUrl, width: enc.width, height: enc.height, source: "upload", createdAt: Date.now() },
    };
  } finally {
    bitmap.close();
  }
}

/** Store the photo in IndexedDB and tell any open side panel. */
export async function storePersonPhoto(photo: PersonPhoto): Promise<void> {
  await savePhoto(photo);
  await sendRuntime({ type: "PHOTO_SAVED" });
}
