import type { Request, Response, NextFunction, RequestHandler } from "express";
import multer from "multer";
import { AppError } from "./errorHandler.js";
import {
  MAX_IMAGE_SIZE_MB,
  ALLOWED_IMAGE_TYPES,
  MAX_DOCUMENT_SIZE_MB,
  ALLOWED_DOCUMENT_TYPES,
  MAX_AUDIO_SIZE_MB,
  ALLOWED_AUDIO_TYPES,
} from "../shared/index.js";

const MB = 1024 * 1024;

interface UploadOptions {
  allowedTypes: readonly string[];
  maxSizeMb: number;
  /** Libellé humain des formats acceptés, pour le message d'erreur */
  typesLabel: string;
}

export interface Upload {
  single(field: string): RequestHandler;
}

/**
 * Crée un middleware d'upload en mémoire (pas de fichier tmp sur disque).
 * Les erreurs multer sont converties en AppError (400/413) au lieu de tomber en 500.
 */
export function createUpload({ allowedTypes, maxSizeMb, typesLabel }: UploadOptions): Upload {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSizeMb * MB },
    fileFilter: (_req, file, cb) => {
      if (allowedTypes.includes(file.mimetype)) cb(null, true);
      else cb(new AppError(400, "INVALID_FILE_TYPE", `Type de fichier non autorisé (${typesLabel} uniquement)`));
    },
  });

  return {
    single: (field) => (req: Request, res: Response, next: NextFunction) => {
      upload.single(field)(req, res, (err: unknown) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return next(new AppError(413, "FILE_TOO_LARGE", `Fichier trop volumineux (max ${maxSizeMb} Mo)`));
          }
          return next(new AppError(400, "UPLOAD_ERROR", err.message));
        }
        next(err);
      });
    },
  };
}

/** Images (produits, logos, avatars, agences, pubs...) — 5 Mo, JPEG/PNG/WEBP */
export const imageUpload = createUpload({
  allowedTypes: ALLOWED_IMAGE_TYPES,
  maxSizeMb: MAX_IMAGE_SIZE_MB,
  typesLabel: "JPEG, PNG, WEBP",
});

/** Documents légaux / KYC — 10 Mo, images ou PDF */
export const documentUpload = createUpload({
  allowedTypes: ALLOWED_DOCUMENT_TYPES,
  maxSizeMb: MAX_DOCUMENT_SIZE_MB,
  typesLabel: "JPEG, PNG, WEBP, PDF",
});

/**
 * Médias du chat — image ou audio. Multer n'applique qu'une limite globale :
 * on autorise la taille audio ici, la limite image est revérifiée par le controller
 * via assertImageSize().
 */
export const chatMediaUpload = createUpload({
  allowedTypes: [...ALLOWED_IMAGE_TYPES, ...ALLOWED_AUDIO_TYPES],
  maxSizeMb: MAX_AUDIO_SIZE_MB,
  typesLabel: "image JPEG/PNG/WEBP ou audio MP3/M4A/WAV",
});

/** Rejette une image dépassant MAX_IMAGE_SIZE_MB (pour les uploads mixtes image/audio) */
export function assertImageSize(file: Express.Multer.File): void {
  if (file.mimetype.startsWith("image/") && file.size > MAX_IMAGE_SIZE_MB * MB) {
    throw new AppError(413, "FILE_TOO_LARGE", `Image trop volumineuse (max ${MAX_IMAGE_SIZE_MB} Mo)`);
  }
}
