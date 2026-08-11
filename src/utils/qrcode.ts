import crypto from "crypto";
import QRCode from "qrcode";

export async function generateQrCode(orderId: string): Promise<string> {
  const token = crypto
    .createHash("sha256")
    .update(`${orderId}-${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 32);

  return token;
}

/** Returns a base64 PNG data URL of the QR code */
export async function generateQrCodeImage(token: string): Promise<string> {
  return QRCode.toDataURL(token, {
    width: 300,
    margin: 2,
    color: { dark: "#0f172a", light: "#ffffff" },
  });
}

/** 6-digit numeric backup code derived from the token */
export function numericCode(token: string): string {
  const num = parseInt(token.slice(0, 6), 16);
  return String(num % 1_000_000).padStart(6, "0");
}
