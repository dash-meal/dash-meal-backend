import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";
import { v4 as uuidv4 } from "uuid";
import path from "node:path";

const ALLOWED_TYPES = ["id_card", "driving_license", "photo", "other"] as const;
type DocType = (typeof ALLOWED_TYPES)[number];

const DRIVER_DOCS_BUCKET = "driver-documents";
const DOCS_NEEDED_FOR_SUBMISSION = 2;

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError(400, "INVALID_FILE_TYPE", "Type de fichier non supporté (JPEG, PNG, WebP, PDF acceptés)"));
    }
  },
});

export async function getDriverDocs(req: Request, res: Response, next: NextFunction) {
  try {
    const { driver_id } = req.params;

    // Récupérer le conducteur avec son statut KYC
    const { data: driver, error: driverErr } = await supabase
      .from("drivers")
      .select("id, name, phone, kyc_status, created_at, brand_id")
      .eq("id", driver_id)
      .single();

    if (driverErr) throw new AppError(driverErr.code === "PGRST116" ? 404 : 500, driverErr.code === "PGRST116" ? "NOT_FOUND" : "DB_ERROR", driverErr.code === "PGRST116" ? "Conducteur introuvable" : driverErr.message);
    if (!driver) throw new AppError(404, "NOT_FOUND", "Conducteur introuvable");

    // Vérifier isolation marque pour admin
    const user = req.user!;
    if (user.role === "admin" && driver.brand_id !== user.brand_id) {
      throw new AppError(403, "FORBIDDEN", "Ce conducteur n'appartient pas à votre marque");
    }

    // Récupérer les documents
    const { data: documents, error: docsErr } = await supabase
      .from("driver_documents")
      .select("id, type, file_url, uploaded_at, status")
      .eq("driver_id", driver_id)
      .order("uploaded_at", { ascending: false });

    if (docsErr) throw new AppError(500, "DB_ERROR", docsErr.message);

    sendSuccess(res, { ...driver, documents: documents ?? [] });
  } catch (err) {
    next(err);
  }
}

export async function uploadDriverDoc(req: Request, res: Response, next: NextFunction) {
  try {
    const { driver_id } = req.params;
    const user = req.user!;
    const docType = req.body.type as DocType;

    if (!ALLOWED_TYPES.includes(docType)) {
      throw new AppError(400, "INVALID_DOC_TYPE", `Type de document invalide. Valeurs: ${ALLOWED_TYPES.join(", ")}`);
    }

    if (!req.file) throw new AppError(400, "MISSING_FILE", "Aucun fichier fourni");

    // Vérifier que le conducteur existe
    const { data: driver, error: driverErr } = await supabase
      .from("drivers")
      .select("id, brand_id, kyc_status")
      .eq("id", driver_id)
      .single();

    if (driverErr) throw new AppError(driverErr.code === "PGRST116" ? 404 : 500, driverErr.code === "PGRST116" ? "NOT_FOUND" : "DB_ERROR", driverErr.code === "PGRST116" ? "Conducteur introuvable" : driverErr.message);
    if (!driver) throw new AppError(404, "NOT_FOUND", "Conducteur introuvable");

    // Un conducteur ne peut uploader que ses propres documents
    if (user.role === "driver" && driver_id !== user.id) {
      throw new AppError(403, "FORBIDDEN", "Vous ne pouvez uploader que vos propres documents");
    }

    // Vérifier isolation marque pour admin
    if (user.role === "admin" && driver.brand_id !== user.brand_id) {
      throw new AppError(403, "FORBIDDEN", "Ce conducteur n'appartient pas à votre marque");
    }

    // Upload vers Supabase Storage
    const ext = path.extname(req.file.originalname).toLowerCase() || ".jpg";
    const filename = `${driver_id}/${docType}_${uuidv4()}${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from(DRIVER_DOCS_BUCKET)
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (uploadErr) throw new AppError(500, "UPLOAD_ERROR", "Échec du téléchargement du document");

    const { data: urlData } = supabase.storage
      .from(DRIVER_DOCS_BUCKET)
      .getPublicUrl(filename);

    // Insérer dans driver_documents
    const { data: doc, error: insertErr } = await supabase
      .from("driver_documents")
      .insert({
        driver_id,
        type: docType,
        file_url: urlData.publicUrl,
        storage_path: filename,
        status: "pending",
        uploaded_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertErr) throw new AppError(500, "DB_ERROR", insertErr.message);

    // Compter les documents actuels
    const { count } = await supabase
      .from("driver_documents")
      .select("id", { count: "exact", head: true })
      .eq("driver_id", driver_id);

    // Mettre à jour kyc_status → submitted si au moins 2 documents
    if ((count ?? 0) >= DOCS_NEEDED_FOR_SUBMISSION && driver.kyc_status === "pending") {
      await supabase
        .from("drivers")
        .update({ kyc_status: "submitted", updated_at: new Date().toISOString() })
        .eq("id", driver_id);
    }

    sendCreated(res, doc, "Document téléchargé avec succès");
  } catch (err) {
    next(err);
  }
}

export async function listDriversKyc(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const kycStatus = req.query.kyc_status as string | undefined;

    let query = supabase
      .from("drivers")
      .select(`
        id, name, phone, kyc_status, created_at, brand_id,
        doc_count:driver_documents(count)
      `)
      .order("created_at", { ascending: false });

    // Isolation marque pour admin
    if (user.role === "admin") {
      if (!user.brand_id) throw new AppError(403, "FORBIDDEN", "Marque non associée");
      query = query.eq("brand_id", user.brand_id);
    }

    if (kycStatus) query = query.eq("kyc_status", kycStatus);

    const { data, error } = await query;
    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

export async function reviewDriverKyc(req: Request, res: Response, next: NextFunction) {
  try {
    const { driver_id } = req.params;
    const { approved, reason } = req.body as { approved: boolean; reason?: string };
    const user = req.user!;

    // Vérifier que le conducteur existe
    const { data: driver, error: driverErr } = await supabase
      .from("drivers")
      .select("id, brand_id, kyc_status")
      .eq("id", driver_id)
      .single();

    if (driverErr) throw new AppError(driverErr.code === "PGRST116" ? 404 : 500, driverErr.code === "PGRST116" ? "NOT_FOUND" : "DB_ERROR", driverErr.code === "PGRST116" ? "Conducteur introuvable" : driverErr.message);
    if (!driver) throw new AppError(404, "NOT_FOUND", "Conducteur introuvable");

    // Vérifier isolation marque
    if (user.role === "admin" && driver.brand_id !== user.brand_id) {
      throw new AppError(403, "FORBIDDEN", "Ce conducteur n'appartient pas à votre marque");
    }

    if (driver.kyc_status !== "submitted") {
      throw new AppError(422, "INVALID_KYC_STATUS", "Ce dossier n'est pas en attente de révision");
    }

    const newStatus = approved ? "approved" : "rejected";

    const { data, error } = await supabase
      .from("drivers")
      .update({
        kyc_status: newStatus,
        kyc_reviewed_by: user.id,
        kyc_reviewed_at: new Date().toISOString(),
        kyc_rejection_reason: approved ? null : (reason ?? null),
        updated_at: new Date().toISOString(),
      })
      .eq("id", driver_id)
      .select("id, kyc_status")
      .single();

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, data, approved ? "KYC approuvé" : "KYC rejeté");
  } catch (err) {
    next(err);
  }
}
