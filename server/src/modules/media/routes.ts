import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../../middleware/auth.js";
import { config } from "../../config.js";
import { uploadFile } from "../../lib/storage/index.js";

export const mediaRouter = Router();

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "application/pdf",
  "text/plain",
]);

// Buffers the whole file in memory rather than streaming to disk directly -
// needed so the same route handler works for both storage drivers (the
// disk driver used to have multer write straight to config.uploadsDir
// itself; the S3 driver needs the bytes to PUT them to a bucket instead).
// Fine given maxUploadBytes's default 8MB cap - not meant for much larger
// files.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      cb(new Error("unsupported_content_type"));
      return;
    }
    cb(null, true);
  },
});

mediaRouter.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing_file" });
  const { url } = await uploadFile({
    buffer: req.file.buffer,
    originalFilename: req.file.originalname,
    contentType: req.file.mimetype,
  });
  res.status(201).json({
    url,
    filename: req.file.originalname,
    contentType: req.file.mimetype,
    size: req.file.size,
  });
});

// Surfaces multer's fileFilter/size errors as JSON instead of an HTML 500.
mediaRouter.use((err: Error, _req: unknown, res: import("express").Response, next: import("express").NextFunction) => {
  if (err) {
    res.status(400).json({ error: "upload_failed", message: err.message });
    return;
  }
  next();
});
