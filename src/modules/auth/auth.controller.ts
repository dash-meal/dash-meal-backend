import type { Request, Response, NextFunction } from "express";
import * as authService from "./auth.service.js";

export async function registerUser(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.registerUser(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function verifyPhone(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.verifyUserPhone(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function verifyEmail(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.verifyUserEmail(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function loginUser(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.loginUser(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function loginDriver(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.loginDriver(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function loginAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.loginAdmin(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function verifyAdminOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.verifyAdminOtp(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function loginSuperAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.loginSuperAdmin(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function verifySuperAdminOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.verifySuperAdminOtp(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function registerSuperAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.registerSuperAdmin(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function refreshTokens(req: Request, res: Response, next: NextFunction) {
  try {
    const { refresh_token } = req.body;
    const tokens = await authService.refreshTokens(refresh_token);
    res.status(200).json({ success: true, data: tokens });
  } catch (err) {
    next(err);
  }
}

export async function applyBrand(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.applyBrand(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function requestReset(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.requestPasswordReset(req.body.phone);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function resendEmailOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.resendUserEmailOtp(req.body.email);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.resetPassword(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function googleAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.googleAuth(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function googleAuthSupabase(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.googleAuthSupabase(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function appleAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.appleAuth(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function sendDriverOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.sendDriverOtp(req.body.phone);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function verifyDriverOtp(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await authService.verifyDriverOtp(req.body.phone, req.body.code);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
