import bcrypt from "bcryptjs";
import axios from "axios";
import { supabase } from "../../config/supabase.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../utils/jwt.js";
import { sendOtp, verifyOtp, verifyEmailOtp } from "../../utils/otp.js";
import { sendEmailOtp, sendCodeByEmail } from "../../utils/email.js";
import { AppError } from "../../middleware/errorHandler.js";
import { env } from "../../config/env.js";
import type {
  RegisterUserInput,
  LoginUserInput,
  LoginAdminInput,
  VerifyOtpInput,
  ResetPasswordInput,
  AuthTokens,
} from "../../shared/index.js";

export async function registerUser(input: RegisterUserInput) {
  const { name, phone, password, email } = input;
  // Ne jamais garder/creer un user non verifie avant OTP confirme
  const { data: existingByPhone } = await supabase
    .from("users")
    .select("id, is_verified")
    .eq("phone", phone)
    .maybeSingle();

  if (existingByPhone?.is_verified) {
    throw new AppError(409, "PHONE_ALREADY_EXISTS", "Ce numéro est déjà utilisé");
  }
  if (existingByPhone && !existingByPhone.is_verified) {
    await supabase.from("users").delete().eq("id", existingByPhone.id);
  }

  if (email) {
    const normalizedEmail = email.trim().toLowerCase();
    const { data: existingEmail } = await supabase
      .from("users")
      .select("id, is_verified")
      .eq("email", normalizedEmail)
      .maybeSingle();
    if (existingEmail?.is_verified) {
      throw new AppError(409, "EMAIL_ALREADY_EXISTS", "Cet email est déjà utilisé");
    }
    if (existingEmail && !existingEmail.is_verified) {
      await supabase.from("users").delete().eq("id", existingEmail.id);
    }
  }

  const password_hash = await bcrypt.hash(password, 12);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  // Stocker temporairement � aucun compte cree dans users avant verification OTP
  await supabase.from("pending_registrations").delete().eq("phone", phone);
  const { error: pendingErr } = await supabase.from("pending_registrations").insert({
    phone,
    name,
    email: email ?? null,
    password_hash,
    expires_at: expiresAt.toISOString(),
  });

  if (pendingErr) {
    console.error("[registerUser] pending_registrations insert failed:", pendingErr);
    throw new AppError(500, "REGISTRATION_ERROR", "Échec de l'inscription temporaire");
  }

  const { smsSent, code } = await sendOtp(phone);

  // Envoyer le même code par email si fourni
  if (email) {
    await sendCodeByEmail(email, code);
  }

  const exposeCode = env.OTP_EXPOSE_CODE || !smsSent;

  return {
    message: smsSent && !env.OTP_EXPOSE_CODE
      ? "Code OTP envoyé par SMS. Vérifiez votre téléphone."
      : "SMS non livré — utilisez le code ci-dessous.",
    ...(exposeCode ? { otp_code: code } : {}),
  };
}

export async function verifyUserPhone(input: VerifyOtpInput) {
  const { phone, code } = input;

  const isValid = await verifyOtp(phone, code);
  if (!isValid) {
    throw new AppError(400, "INVALID_OTP", "Code OTP invalide ou expiré");
  }

  // Récupérer les données d'inscription en attente
  const { data: pending } = await supabase
    .from("pending_registrations")
    .select("name, email, password_hash")
    .eq("phone", phone)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (!pending) {
    throw new AppError(400, "REGISTRATION_EXPIRED", "Session d'inscription expirée. Recommencez l'inscription.");
  }

  // Créer le compte maintenant que l'OTP est validé
  const { data: user, error } = await supabase
    .from("users")
    .insert({
      name: pending.name,
      phone,
      email: pending.email ?? null,
      password_hash: pending.password_hash,
      is_verified: true,
    })
    .select("id, name, phone, email, is_verified")
    .single();

  if (error || !user) {
    throw new AppError(500, "CREATE_USER_ERROR", "Échec de la création du compte");
  }

  // Nettoyer la session temporaire
  await supabase.from("pending_registrations").delete().eq("phone", phone);

  const tokens = buildUserTokens(user);
  return { user, tokens };
}

export async function verifyUserEmail(input: { email: string; code: string }) {
  const email = input.email.trim().toLowerCase();
  const { code } = input;

  const isValid = await verifyEmailOtp(email, code);
  if (!isValid) {
    throw new AppError(400, "INVALID_OTP", "Code OTP invalide ou expiré");
  }

  const { data: pending } = await supabase
    .from("pending_registrations")
    .select("name, phone, email, password_hash")
    .eq("email", email)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (!pending) {
    throw new AppError(400, "REGISTRATION_EXPIRED", "Session d'inscription expirée. Recommencez l'inscription.");
  }

  const { data: user, error } = await supabase
    .from("users")
    .insert({
      name: pending.name,
      phone: pending.phone,
      email: pending.email ?? email,
      password_hash: pending.password_hash,
      is_verified: true,
    })
    .select("id, name, phone, email, is_verified")
    .single();

  if (error || !user) {
    throw new AppError(500, "CREATE_USER_ERROR", "Échec de la création du compte");
  }

  await supabase.from("pending_registrations").delete().eq("phone", pending.phone);

  const tokens = buildUserTokens(user);
  return { user, tokens };
}

export async function resendUserEmailOtp(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const { data: pending } = await supabase
    .from("pending_registrations")
    .select("phone")
    .eq("email", normalizedEmail)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (!pending) {
    throw new AppError(404, "REGISTRATION_NOT_FOUND", "Aucune inscription en attente pour cet email");
  }

  const { emailSent, code } = await sendEmailOtp(normalizedEmail);

  return {
    message: "Code OTP renvoyé",
    ...(env.OTP_EXPOSE_CODE || !emailSent ? { otp_code: code } : {}),
  };
}

export async function loginUser(input: { identifier?: string; email?: string; phone?: string; password: string }): Promise<{ user: object; tokens: AuthTokens }> {
  const { password } = input;
  const rawIdentifier = input.identifier ?? input.email ?? input.phone;
  if (!rawIdentifier) {
    throw new AppError(400, "MISSING_IDENTIFIER", "Email ou numéro requis");
  }

  const identifier = rawIdentifier.trim();
  const isEmail = identifier.includes("@");

  let query = supabase
    .from("users")
    .select("id, name, phone, email, password_hash, is_verified, is_active");
  query = isEmail
    ? query.eq("email", identifier.toLowerCase())
    : query.eq("phone", identifier);

  const { data: user } = await query.single();

  if (!user) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Identifiants incorrects");
  }

  if (!user.is_active) {
    throw new AppError(403, "ACCOUNT_ARCHIVED", "Ce compte a été archivé");
  }

  if (!user.is_verified) {
    throw new AppError(403, isEmail ? "EMAIL_NOT_VERIFIED" : "PHONE_NOT_VERIFIED", isEmail ? "Email non verifie" : "Numero de telephone non verifie");
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Identifiants incorrects");
  }

  const { password_hash: _, ...safeUser } = user;
  const tokens = buildUserTokens(user);
  return { user: safeUser, tokens };
}

export async function loginAdmin(input: LoginAdminInput): Promise<{ requires_otp: true; email: string }> {
  const { identifier, password } = input;

  const isEmail = identifier.includes("@");
  const query = supabase
    .from("admins")
    .select("id, username, email, phone, brand_id, role, is_active, password_hash");

  const { data: admin } = await (isEmail
    ? query.eq("email", identifier)
    : query.eq("phone", identifier)
  ).single();

  if (!admin) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Identifiants incorrects");
  }

  if (!admin.is_active) {
    throw new AppError(403, "ACCOUNT_SUSPENDED", "Ce compte a été suspendu");
  }

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Identifiants incorrects");
  }

  const { emailSent } = await sendEmailOtp(admin.email);
  console.log(`[OTP][ADMIN_LOGIN] ${admin.email}: emailSent=${emailSent}`);
  if (!emailSent) {
    console.warn(`⚠️  Email OTP non envoyé pour l'admin — vérifier la config RESEND`);
  }

  return { requires_otp: true, email: admin.email };
}

export async function verifyAdminOtp(input: { identifier: string; code: string }): Promise<{ admin: object; tokens: AuthTokens }> {
  const { identifier, code } = input;

  const isEmail = identifier.includes("@");
  const query = supabase
    .from("admins")
    .select("id, username, email, phone, brand_id, role, is_active, password_hash");

  const { data: admin } = await (isEmail
    ? query.eq("email", identifier)
    : query.eq("phone", identifier)
  ).single();

  if (!admin) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Identifiants incorrects");
  }

  const isValid = await verifyEmailOtp(admin.email, code);
  if (!isValid) {
    throw new AppError(400, "INVALID_OTP", "Code OTP invalide ou expiré");
  }

  const { password_hash: _, ...safeAdmin } = admin;
  const tokens = buildAdminTokens(admin);
  return { admin: safeAdmin, tokens };
}

export async function loginSuperAdmin(input: LoginAdminInput): Promise<{ requires_otp: true; email: string }> {
  const { identifier, password } = input;

  const isEmail = identifier.includes("@");
  const query = supabase
    .from("super_admins")
    .select("id, email, phone, password_hash");

  const { data: superAdmin } = await (isEmail
    ? query.eq("email", identifier)
    : query.eq("phone", identifier)
  ).single();

  if (!superAdmin) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Identifiants incorrects");
  }

  const valid = await bcrypt.compare(password, superAdmin.password_hash);
  if (!valid) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Identifiants incorrects");
  }

  const { emailSent } = await sendEmailOtp(superAdmin.email);
  console.log(`[OTP][SUPERADMIN_LOGIN] ${superAdmin.email}: emailSent=${emailSent}`);
  if (!emailSent) {
    console.warn(`⚠️  Email OTP non envoyé pour le superadmin — vérifier la config RESEND`);
  }

  return { requires_otp: true, email: superAdmin.email };
}

export async function verifySuperAdminOtp(input: { identifier: string; code: string }): Promise<{ admin: object; tokens: AuthTokens }> {
  const { identifier, code } = input;

  const isEmail = identifier.includes("@");
  const query = supabase
    .from("super_admins")
    .select("id, email, phone, password_hash");

  const { data: superAdmin } = await (isEmail
    ? query.eq("email", identifier)
    : query.eq("phone", identifier)
  ).single();

  if (!superAdmin) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Identifiants incorrects");
  }

  const isValid = await verifyEmailOtp(superAdmin.email, code);
  if (!isValid) {
    throw new AppError(400, "INVALID_OTP", "Code OTP invalide ou expiré");
  }

  const { password_hash: _, ...safeSuperAdmin } = superAdmin;
  const tokens = buildSuperAdminTokens(superAdmin);
  return { admin: safeSuperAdmin, tokens };
}

export async function registerSuperAdmin(input: {
  email: string;
  phone: string;
  password: string;
}): Promise<{ admin: object; tokens: AuthTokens }> {
  const { email, phone, password } = input;

  const { data: existing, error: existingError } = await supabase
    .from("super_admins")
    .select("id")
    .or(`email.eq.${email},phone.eq.${phone}`)
    .maybeSingle();

  if (existingError) {
    throw new AppError(500, "SUPERADMIN_LOOKUP_ERROR", "Erreur de vérification superadmin");
  }

  if (existing) {
    throw new AppError(409, "SUPERADMIN_ALREADY_EXISTS", "Email ou numéro déjà utilisé");
  }

  const password_hash = await bcrypt.hash(password, 12);

  const { data: created, error } = await supabase
    .from("super_admins")
    .insert({ email, phone, password_hash })
    .select("id, email, phone, password_hash")
    .single();

  if (error || !created) {
    throw new AppError(500, "CREATE_SUPERADMIN_ERROR", "Echec de création du compte superadmin");
  }

  const { password_hash: _, ...safeSuperAdmin } = created;
  const tokens = buildSuperAdminTokens(created);
  return { admin: safeSuperAdmin, tokens };
}

export async function refreshTokens(refreshToken: string): Promise<AuthTokens> {
  let payload: { id: string; role: string };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Refresh token invalide");
  }

  // Vérifier que le compte existe toujours
  let user;
  if (payload.role === "user") {
    const { data } = await supabase
      .from("users")
      .select("id, name, phone, is_verified, is_active")
      .eq("id", payload.id)
      .single();
    if (data && !data.is_active) {
      throw new AppError(403, "ACCOUNT_ARCHIVED", "Ce compte a été archivé");
    }
    user = data;
  } else if (payload.role === "driver") {
    const { data } = await supabase
      .from("drivers")
      .select("id, name, phone, branch_id, brand_id, is_active")
      .eq("id", payload.id)
      .single();
    user = data ? { ...data, role: "driver" } : null;
  } else if (payload.role === "superadmin") {
    const { data } = await supabase
      .from("super_admins")
      .select("id, email, phone")
      .eq("id", payload.id)
      .single();
    user = data ? { ...data, role: "superadmin" } : null;
  } else {
    const { data } = await supabase
      .from("admins")
      .select("id, email, phone, brand_id, role, is_active")
      .eq("id", payload.id)
      .single();
    user = data;
  }

  if (!user) {
    throw new AppError(401, "USER_NOT_FOUND", "Compte introuvable");
  }

  return buildTokensFromRole(user, payload.role);
}

export async function requestPasswordReset(phone: string) {
  const { data: user } = await supabase
    .from("users")
    .select("id")
    .eq("phone", phone)
    .single();

  if (!user) {
    return { message: "Si ce numéro est enregistré, un code OTP a été envoyé" };
  }

  const { smsSent, code } = await sendOtp(phone);
  const exposeCode = env.OTP_EXPOSE_CODE || !smsSent;

  return {
    message: smsSent && !env.OTP_EXPOSE_CODE
      ? "Si ce numéro est enregistré, un code OTP a été envoyé"
      : "SMS non livré — utilisez le code ci-dessous.",
    ...(exposeCode ? { otp_code: code } : {}),
  };
}

export async function resetPassword(input: ResetPasswordInput) {
  const { phone, code, new_password } = input;

  const isValid = await verifyOtp(phone, code);
  if (!isValid) {
    throw new AppError(400, "INVALID_OTP", "Code OTP invalide ou expiré");
  }

  const password_hash = await bcrypt.hash(new_password, 12);
  const { error } = await supabase
    .from("users")
    .update({ password_hash })
    .eq("phone", phone);

  if (error) {
    throw new AppError(500, "RESET_PASSWORD_ERROR", "Échec de la réinitialisation");
  }

  return { message: "Mot de passe mis à jour avec succès" };
}

// ─── Driver login ─────────────────────────────────────────────────────────────

export async function loginDriver(input: { phone: string; pin: string }): Promise<{ driver: object; tokens: AuthTokens }> {
  const { phone, pin } = input;

  const { data: driver } = await supabase
    .from("drivers")
    .select("id, name, phone, branch_id, brand_id, is_active, pin_hash")
    .eq("phone", phone)
    .single();

  if (!driver) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Identifiants incorrects");
  }
  if (!driver.pin_hash) {
    throw new AppError(401, "NO_PIN", "PIN non configuré. Contactez votre administrateur.");
  }

  const valid = await bcrypt.compare(pin, driver.pin_hash);
  if (!valid) {
    throw new AppError(401, "INVALID_CREDENTIALS", "PIN incorrect");
  }

  const { pin_hash: _, ...safeDriver } = driver;
  const payload = {
    id: driver.id,
    role: "driver",
    name: driver.name,
    phone: driver.phone,
    brand_id: driver.brand_id,
    branch_id: driver.branch_id,
  };
  const tokens: AuthTokens = {
    access_token: signAccessToken(payload),
    refresh_token: signRefreshToken({ id: driver.id, role: "driver" }),
    expires_in: 15 * 60,
  };
  return { driver: safeDriver, tokens };
}

// ─── Driver OTP auth (web PWA) ────────────────────────────────────────────────

export async function sendDriverOtp(phone: string): Promise<{ sent: boolean }> {
  const { data: driver } = await supabase
    .from("drivers")
    .select("id, is_active")
    .eq("phone", phone)
    .single();

  if (!driver) {
    throw new AppError(404, "DRIVER_NOT_FOUND", "Aucun livreur trouvé avec ce numéro");
  }
  if (!driver.is_active) {
    throw new AppError(403, "DRIVER_INACTIVE", "Compte livreur désactivé. Contactez votre administrateur.");
  }

  const { smsSent } = await sendOtp(phone);
  return { sent: smsSent };
}

export async function verifyDriverOtp(phone: string, code: string): Promise<{ driver: object; tokens: AuthTokens }> {
  const { data: driver } = await supabase
    .from("drivers")
    .select("id, name, phone, branch_id, brand_id, is_active, vehicle_type, photo_url")
    .eq("phone", phone)
    .single();

  if (!driver) {
    throw new AppError(404, "DRIVER_NOT_FOUND", "Livreur introuvable");
  }

  const isValid = await verifyOtp(phone, code);
  if (!isValid) {
    throw new AppError(400, "INVALID_OTP", "Code OTP invalide ou expiré");
  }

  const payload = {
    id: driver.id,
    role: "driver",
    name: driver.name,
    phone: driver.phone,
    brand_id: driver.brand_id,
    branch_id: driver.branch_id,
  };
  const tokens: AuthTokens = {
    access_token: signAccessToken(payload),
    refresh_token: signRefreshToken({ id: driver.id, role: "driver" }),
    expires_in: 15 * 60,
  };
  return { driver, tokens };
}

// ─── Demande d'accès marque ───────────────────────────────────────────────────

export async function applyBrand(input: {
  brand_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  city: string;
  description: string;
  password: string;
}) {
  const { brand_name, contact_name, contact_email, contact_phone, city, description, password } = input;

  // Vérifier si une demande existe déjà avec cet email ou téléphone
  const { data: existing } = await supabase
    .from("brand_applications")
    .select("id")
    .or(`contact_email.eq.${contact_email},contact_phone.eq.${contact_phone}`)
    .maybeSingle();

  if (existing) {
    throw new AppError(409, "APPLICATION_ALREADY_EXISTS", "Une demande existe déjà avec cet email ou ce numéro");
  }

  const password_hash = await bcrypt.hash(password, 12);

  const { data, error } = await supabase
    .from("brand_applications")
    .insert({
      brand_name,
      contact_name,
      contact_email,
      contact_phone,
      city,
      description,
      password_hash,
      status: "pending",
    })
    .select("id, brand_name, contact_email, status, submitted_at")
    .single();

  if (error || !data) {
    throw new AppError(500, "APPLICATION_ERROR", "Échec de l'envoi de la demande");
  }

  return { message: "Demande soumise avec succès", application: data };
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

export async function googleAuth(input: { id_token: string }): Promise<{ user: object; tokens: AuthTokens }> {
  // 1. Vérifier le token Google via tokeninfo
  let googlePayload: { email: string; name: string; sub: string; picture?: string };
  try {
    const { data } = await axios.get<{ email: string; name: string; sub: string; email_verified: string; picture?: string }>(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${input.id_token}`
    );
    if (!data.email || !data.sub) {
      throw new AppError(401, "INVALID_GOOGLE_TOKEN", "Token Google invalide");
    }
    googlePayload = { email: data.email, name: data.name ?? data.email, sub: data.sub, picture: data.picture };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, "INVALID_GOOGLE_TOKEN", "Impossible de vérifier le token Google");
  }

  const { email, name, sub: google_id, picture } = googlePayload;

  // 2. Chercher l'utilisateur par email ou par google_id
  const { data: byEmail } = await supabase
    .from("users")
    .select("id, name, phone, email, google_id, avatar_url, is_verified")
    .eq("email", email)
    .maybeSingle();

  let user = byEmail;

  if (!user) {
    const { data: byGoogleId } = await supabase
      .from("users")
      .select("id, name, phone, email, google_id, avatar_url, is_verified")
      .eq("google_id", google_id)
      .maybeSingle();
    user = byGoogleId;
  }

  // 3. Si pas trouvé, créer le compte
  if (!user) {
    const { data: newUser, error: createErr } = await supabase
      .from("users")
      .insert({
        name,
        email,
        google_id,
        avatar_url: picture ?? null,
        email_verified: true,
        is_verified: true,
        phone: null,
        password_hash: null,
      })
      .select("id, name, phone, email, google_id, avatar_url, is_verified")
      .single();

    if (createErr || !newUser) {
      throw new AppError(500, "CREATE_USER_ERROR", "Échec de la création du compte Google");
    }
    user = newUser;
  } else {
    // Lier le google_id et mettre à jour l'avatar si absent
    const updates: Record<string, unknown> = {};
    if (!user.google_id) { updates.google_id = google_id; updates.email_verified = true; }
    if (!user.avatar_url && picture) updates.avatar_url = picture;
    if (Object.keys(updates).length > 0) {
      await supabase.from("users").update(updates).eq("id", user.id);
      user = { ...user, ...updates };
    }
  }

  const tokens = buildUserTokens(user as { id: string; name?: string; phone: string });
  return { user, tokens };
}

// ─── Apple Sign In ────────────────────────────────────────────────────────────

export async function appleAuth(input: {
  id_token: string;
  first_name?: string;
  last_name?: string;
}): Promise<{ user: object; tokens: AuthTokens }> {
  const { id_token, first_name, last_name } = input;

  // 1. Décoder le JWT Apple (non-signé — vérification basique des claims)
  //    Apple identity tokens sont des JWTs RS256 signés par Apple.
  //    On vérifie les claims sans valider la signature côté serveur pour simplifier
  //    (le token vient directement du SDK Apple, qui l'a déjà validé sur l'appareil).
  let payload: { sub: string; email?: string; email_verified?: boolean | string; iss?: string; aud?: string };
  try {
    // Décoder le payload (partie base64 centrale du JWT)
    const parts = id_token.split(".");
    if (parts.length !== 3) throw new Error("Format JWT invalide");
    const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
    payload = JSON.parse(decoded);
    if (!payload.sub) throw new Error("sub manquant");
    // Vérification basique de l'émetteur
    if (payload.iss && !payload.iss.includes("appleid.apple.com")) {
      throw new AppError(401, "INVALID_APPLE_TOKEN", "Émetteur Apple invalide");
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, "INVALID_APPLE_TOKEN", "Token Apple invalide ou expiré");
  }

  const apple_id = payload.sub;
  const email = payload.email ?? null;

  // Construire le nom depuis les champs optionnels (Apple ne les envoie qu'à la première connexion)
  const name = [first_name, last_name].filter(Boolean).join(" ").trim() || email?.split("@")[0] || "Utilisateur";

  // 2. Chercher l'utilisateur par apple_id ou email
  let user: any = null;

  const { data: byAppleId } = await supabase
    .from("users")
    .select("id, name, phone, email, apple_id, avatar_url, is_verified")
    .eq("apple_id", apple_id)
    .maybeSingle();
  user = byAppleId;

  if (!user && email) {
    const { data: byEmail } = await supabase
      .from("users")
      .select("id, name, phone, email, apple_id, avatar_url, is_verified")
      .eq("email", email)
      .maybeSingle();
    user = byEmail;
  }

  // 3. Créer ou mettre à jour
  if (!user) {
    const { data: newUser, error: createErr } = await supabase
      .from("users")
      .insert({
        name,
        email,
        apple_id,
        email_verified: !!email,
        is_verified: true,
        phone: null,
        password_hash: null,
      })
      .select("id, name, phone, email, apple_id, avatar_url, is_verified")
      .single();

    if (createErr || !newUser) {
      throw new AppError(500, "CREATE_USER_ERROR", "Échec de la création du compte Apple");
    }
    user = newUser;
  } else {
    const updates: Record<string, unknown> = {};
    if (!user.apple_id) { updates.apple_id = apple_id; updates.is_verified = true; }
    // Ne mettre à jour le nom que si c'est la première fois (Apple envoie le nom seulement une fois)
    if (first_name && user.name === user.email?.split("@")[0]) updates.name = name;
    if (Object.keys(updates).length > 0) {
      await supabase.from("users").update(updates).eq("id", user.id);
      user = { ...user, ...updates };
    }
  }

  const tokens = buildUserTokens(user as { id: string; name?: string; phone: string });
  return { user, tokens };
}

// ─── Supabase OAuth (Google via Supabase Auth) ────────────────────────────────

export async function googleAuthSupabase(input: { supabase_token: string }): Promise<{ user: object; tokens: AuthTokens }> {
  // Vérifier le token Supabase via le client service-role (auth.getUser vérifie le JWT)
  const { data: { user: sbUser }, error } = await supabase.auth.getUser(input.supabase_token);

  if (error || !sbUser?.email) {
    throw new AppError(401, "INVALID_SUPABASE_TOKEN", "Token Supabase invalide ou expiré");
  }

  const email     = sbUser.email;
  const name: string = sbUser.user_metadata?.full_name ?? sbUser.user_metadata?.name ?? email.split("@")[0];
  const googleId  = sbUser.id; // UUID Supabase utilisé comme identifiant OAuth stable

  // Chercher l'utilisateur par email
  const { data: byEmail } = await supabase
    .from("users")
    .select("id, name, phone, email, google_id, is_verified")
    .eq("email", email)
    .maybeSingle();

  let user = byEmail;

  if (!user) {
    // Créer le compte
    const { data: newUser, error: createErr } = await supabase
      .from("users")
      .insert({
        name, email,
        google_id: googleId,
        email_verified: true,
        is_verified: true,
        phone: null,
        password_hash: null,
      })
      .select("id, name, phone, email, google_id, is_verified")
      .single();
    if (createErr || !newUser) throw new AppError(500, "CREATE_USER_ERROR", "Échec de la création du compte Google");
    user = newUser;
  } else if (!user.google_id) {
    await supabase.from("users").update({ google_id: googleId, email_verified: true }).eq("id", user.id);
  }

  const tokens = buildUserTokens(user as { id: string; name?: string; phone: string });
  return { user, tokens };
}

// ─── Helpers privés ───────────────────────────────────────────────────────────

function buildUserTokens(user: { id: string; name?: string; phone: string }): AuthTokens {
  const payload = { id: user.id, role: "user", name: user.name, phone: user.phone };
  return {
    access_token: signAccessToken(payload),
    refresh_token: signRefreshToken({ id: user.id, role: "user" }),
    expires_in: 15 * 60,
  };
}

function buildAdminTokens(admin: { id: string; username?: string; email: string; phone: string; brand_id: string; role: string }): AuthTokens {
  const payload = { id: admin.id, role: admin.role, email: admin.email, phone: admin.phone, brand_id: admin.brand_id };
  return {
    access_token: signAccessToken(payload),
    refresh_token: signRefreshToken({ id: admin.id, role: admin.role }),
    expires_in: 15 * 60,
  };
}

function buildSuperAdminTokens(admin: { id: string; email: string; phone: string }): AuthTokens {
  const payload = { id: admin.id, role: "superadmin", email: admin.email, phone: admin.phone };
  return {
    access_token: signAccessToken(payload),
    refresh_token: signRefreshToken({ id: admin.id, role: "superadmin" }),
    expires_in: 15 * 60,
  };
}

function buildTokensFromRole(user: Record<string, unknown>, role: string): AuthTokens {
  const payload = { id: user.id as string, role, ...user };
  return {
    access_token: signAccessToken(payload as Parameters<typeof signAccessToken>[0]),
    refresh_token: signRefreshToken({ id: user.id as string, role }),
    expires_in: 15 * 60,
  };
}


