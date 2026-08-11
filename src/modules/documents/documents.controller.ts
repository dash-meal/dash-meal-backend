import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";
import { env } from "../../config/env.js";

const ALLOWED_TYPES = ["niu", "logo", "online_presence", "rccm", "other"] as const;
type DocumentType = (typeof ALLOWED_TYPES)[number];

// ─── Upload d'un document KYC ────────────────────────────────────────────────
// Cette route est publique dans le cadre du formulaire de demande d'accès.
// application_id et doc_type sont passés en form-data avec le fichier.
export async function uploadDocument(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) {
      throw new AppError(400, "MISSING_FILE", "Aucun fichier fourni");
    }

    const { application_id, doc_type } = req.body as {
      application_id?: string;
      doc_type?: string;
    };

    if (!application_id) {
      throw new AppError(400, "MISSING_APPLICATION_ID", "application_id requis");
    }
    if (!doc_type || !ALLOWED_TYPES.includes(doc_type as DocumentType)) {
      throw new AppError(
        400,
        "INVALID_DOC_TYPE",
        `doc_type invalide. Valeurs acceptées : ${ALLOWED_TYPES.join(", ")}`
      );
    }

    // Vérifier que la demande existe et est en attente
    const { data: application, error: appErr } = await supabase
      .from("brand_applications")
      .select("id, status")
      .eq("id", application_id)
      .single();

    if (appErr || !application) {
      throw new AppError(404, "APPLICATION_NOT_FOUND", "Demande d'accès introuvable");
    }
    if ((application as { status: string }).status !== "pending") {
      throw new AppError(400, "APPLICATION_NOT_PENDING", "Seules les demandes en attente acceptent des documents");
    }

    // Construire le chemin de stockage
    const ext = req.file.originalname.split(".").pop() ?? "bin";
    const timestamp = Date.now();
    const storagePath = `${application_id}/${doc_type}_${timestamp}.${ext}`;

    // Upload vers Supabase Storage
    const { error: storageErr } = await supabase.storage
      .from(env.STORAGE_BUCKET_DOCUMENTS)
      .upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (storageErr) {
      throw new AppError(500, "UPLOAD_FAILED", `Erreur lors de l'upload : ${storageErr.message}`);
    }

    // Récupérer l'URL publique
    const { data: publicUrlData } = supabase.storage
      .from(env.STORAGE_BUCKET_DOCUMENTS)
      .getPublicUrl(storagePath);

    // Enregistrer le document en base (upsert par application + type pour remplacer si re-soumis)
    const { data: doc, error: dbErr } = await supabase
      .from("brand_documents")
      .upsert(
        {
          application_id,
          type: doc_type,
          url: publicUrlData.publicUrl,
          is_verified: false,
        },
        { onConflict: "application_id,type" }
      )
      .select()
      .single();

    if (dbErr) throw new AppError(500, "DB_ERROR", "Erreur lors de l'enregistrement");

    sendCreated(res, doc, "Document uploadé avec succès");
  } catch (err) {
    next(err);
  }
}

// ─── Superadmin : lister les documents d'une demande ─────────────────────────
export async function listApplicationDocuments(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("brand_documents")
      .select("*")
      .eq("application_id", req.params.applicationId)
      .order("type");

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

// ─── Superadmin : marquer un document comme vérifié ──────────────────────────
export async function verifyDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("brand_documents")
      .select("id")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Document introuvable");

    await supabase
      .from("brand_documents")
      .update({ is_verified: true })
      .eq("id", req.params.id);

    sendSuccess(res, { id: req.params.id }, "Document vérifié");
  } catch (err) {
    next(err);
  }
}

// ─── Superadmin : supprimer un document ──────────────────────────────────────
export async function deleteDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("brand_documents")
      .select("id, url")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Document introuvable");

    const doc = data as { id: string; url: string };

    // Extraire le chemin relatif depuis l'URL publique
    const bucketPrefix = `${env.STORAGE_BUCKET_DOCUMENTS}/`;
    const urlParts = doc.url.split(bucketPrefix);
    if (urlParts.length > 1) {
      await supabase.storage.from(env.STORAGE_BUCKET_DOCUMENTS).remove([urlParts[1]]);
    }

    await supabase.from("brand_documents").delete().eq("id", req.params.id);

    sendSuccess(res, { id: req.params.id }, "Document supprimé");
  } catch (err) {
    next(err);
  }
}
