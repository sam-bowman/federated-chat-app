import { Router } from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { requireAuth } from "../../middleware/auth.js";
import { config } from "../../config.js";

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

fs.mkdirSync(config.uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: config.uploadsDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 16);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      cb(new Error("unsupported_content_type"));
      return;
    }
    cb(null, true);
  },
});

mediaRouter.post("/upload", requireAuth, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "missing_file" });
  res.status(201).json({
    url: `/uploads/${req.file.filename}`,
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
