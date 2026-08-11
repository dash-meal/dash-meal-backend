export type UserRole = "user" | "admin" | "superadmin" | "driver" | "branch_manager";

export type AdminRole = "admin" | "superadmin";

export type OrderStatus =
  | "pending"
  | "confirmed"
  | "preparing"
  | "ready"
  | "delivering"
  | "delivered"
  | "cancelled";

export type OrderType = "collect" | "delivery";

export type PaymentMethod = "mobile_money" | "cash_on_delivery" | "wallet";

export type PaymentStatus = "pending" | "paid" | "failed" | "refunded";

export type CommissionType = "online" | "inperson";

export type BrandApplicationStatus = "pending" | "approved" | "rejected" | "suspended";

export type DocumentType = "niu" | "logo" | "online_presence" | "rccm" | "other";

export type DeliveryStatus = "assigned" | "picked_up" | "on_the_way" | "delivered" | "failed";

export type ConversationType = "client_driver" | "client_support";

export type SupportedLocale = "fr" | "en";
