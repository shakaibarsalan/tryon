// The MediaPipe files the live mirror uses, all in dist/mediapipe (scripts/fetch-models.mjs fetches
// the models; the build copies the WASM runtime from @mediapipe/tasks-vision).

export const POSE_MODEL = "pose_landmarker_lite.task";
export const SEGMENT_MODEL = "selfie_multiclass_256x256.tflite";

/** Pose landmarker settings, the same for the live camera and for garment photos. */
export const POSE_SETTINGS = {
  numPoses: 1,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
} as const;
