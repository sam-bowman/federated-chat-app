import { Router, type RequestHandler } from "express";
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

// Everything multer can fail with here is about the request itself: the file is held in memory, so there is no storage to fail, and what is
// left is a body that is cut short or malformed, a file over the limit, or one of a type that is not allowed. All of those are the
// sender's, so all of them are a 400. A truncated body used to be a 500: busboy's "Unexpected end of form" is a plain Error, which the
// check on MulterError below did not recognise (found by the dynamic scan, #250).
const receiveFile: RequestHandler = (req, res, next) => {
  upload.single("file")(req, res, (err?: unknown) => {
    if (!err) return next();
    res.status(400).json({ error: "upload_failed", message: err instanceof Error ? err.message : "The upload could not be read." });
  });
};

mediaRouter.post("/upload", requireAuth, receiveFile, async (req, res) => {
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
