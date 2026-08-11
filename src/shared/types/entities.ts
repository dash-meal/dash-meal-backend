import type {
  AdminRole,
  BrandApplicationStatus,
  CommissionType,
  ConversationType,
  DeliveryStatus,
  DocumentType,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
} from "./roles.js";

// ─── Identités ───────────────────────────────────────────────────────────────

export interface BranchManager {
  id: string;
  branch_id: string;
  brand_id: string;
  name: string;
  phone: string;
  email: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DriverWallet {
  id: string;
  driver_id: string;
  brand_id: string;
  balance: number;
  total_earned: number;
  total_withdrawn: number;
  created_at: string;
  updated_at: string;
}

export interface DriverWalletTransaction {
  id: string;
  driver_id: string;
  brand_id: string;
  type: "earning" | "withdrawal";
  amount: number;
  balance_after: number;
  description: string | null;
  order_id: string | null;
  campay_reference: string | null;
  status: "pending" | "completed" | "failed";
  created_at: string;
}

export interface StockMovement {
  id: string;
  branch_id: string;
  product_id: string;
  branch_manager_id: string | null;
  admin_id: string | null;
  type: "restock" | "adjustment" | "sale" | "removal" | "loss";
  quantity_change: number;
  quantity_before: number;
  quantity_after: number;
  note: string | null;
  created_at: string;
}

export interface BranchHour {
  id: string;
  branch_id: string;
  day_of_week: number; // 0=dimanche … 6=samedi
  open_time: string;   // "HH:mm"
  close_time: string;  // "HH:mm"
  is_closed: boolean;
}

export interface OrderStatusHistoryEntry {
  id: string;
  order_id: string;
  status: string;
  changed_at: string;
  changed_by: string | null;
  changed_by_role: string | null;
  note: string | null;
}

export interface SuperAdmin {
  id: string;
  email: string;
  phone: string;
  created_at: string;
}

export interface Admin {
  id: string;
  username: string;
  email: string;
  phone: string;
  brand_id: string;
  role: AdminRole;
  is_active: boolean;
  created_at: string;
}

export interface User {
  id: string;
  name: string;
  phone: string;
  is_verified: boolean;
  preferred_locale: string;
  created_at: string;
}

export interface Driver {
  id: string;
  name: string;
  phone: string;
  admin_id: string;
  branch_id: string | null;
  is_active: boolean;
  created_at: string;
}

// ─── Structure commerciale ────────────────────────────────────────────────────

export interface Brand {
  id: string;
  name: string;
  logo_url: string | null;
  description: string | null;
  is_active: boolean;
  created_at: string;
}

export interface Branch {
  id: string;
  brand_id: string;
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  phone: string | null;
  hours: BranchHours;
  is_active: boolean;
  created_at: string;
}

export interface BranchHours {
  monday?: DayHours;
  tuesday?: DayHours;
  wednesday?: DayHours;
  thursday?: DayHours;
  friday?: DayHours;
  saturday?: DayHours;
  sunday?: DayHours;
}

export interface DayHours {
  open: string; // "HH:mm"
  close: string; // "HH:mm"
  is_closed?: boolean;
}

export interface DeliveryZone {
  id: string;
  branch_id: string;
  name: string;
  polygon_coords: Array<{ lat: number; lng: number }>;
  delivery_fee: number;
  min_order: number;
  is_active: boolean;
}

// ─── Catalogue ────────────────────────────────────────────────────────────────

export interface Category {
  id: string;
  name_fr: string;
  name_en: string;
  icon: string | null;
  parent_id: string | null;
  brand_id: string | null; // null = catégorie globale
  sort_order: number;
}

export interface Product {
  id: string;
  brand_id: string;
  category_id: string;
  name_fr: string;
  name_en: string;
  description_fr: string | null;
  description_en: string | null;
  price: number; // en FCFA
  is_active: boolean;
  created_at: string;
}

export interface ProductImage {
  id: string;
  product_id: string;
  url: string;
  is_primary: boolean;
  sort_order: number;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  name_fr: string;
  name_en: string;
  price_modifier: number; // +/- sur le prix de base
  is_active: boolean;
}

export interface BranchStock {
  id: string;
  branch_id: string;
  product_id: string;
  variant_id: string | null;
  stock_qty: number;
  updated_at: string;
}

// ─── Commandes ────────────────────────────────────────────────────────────────

export interface Cart {
  id: string;
  user_id: string;
  branch_id: string;
  updated_at: string;
}

export interface CartItem {
  id: string;
  cart_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
}

export interface Order {
  id: string;
  user_id: string;
  branch_id: string;
  type: OrderType;
  status: OrderStatus;
  subtotal: number;
  delivery_fee: number;
  total: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
}

export interface OrderStatusHistory {
  id: string;
  order_id: string;
  status: OrderStatus;
  changed_at: string;
  changed_by: string; // user_id ou admin_id
  changed_by_role: string;
  note: string | null;
}

export interface TimeSlot {
  id: string;
  branch_id: string;
  date: string; // "YYYY-MM-DD"
  start_time: string; // "HH:mm"
  end_time: string; // "HH:mm"
  capacity: number;
  booked: number;
}

export interface CollectOrder {
  id: string;
  order_id: string;
  slot_id: string;
  qr_code: string;
  pickup_status: "waiting" | "picked_up";
  picked_up_at: string | null;
}

export interface Delivery {
  id: string;
  order_id: string;
  driver_id: string | null;
  address: string;
  lat: number;
  lng: number;
  status: DeliveryStatus;
  started_at: string | null;
  delivered_at: string | null;
}

// ─── Paiement ─────────────────────────────────────────────────────────────────

export interface Payment {
  id: string;
  order_id: string;
  method: PaymentMethod;
  amount: number;
  status: PaymentStatus;
  provider_ref: string | null;
  provider: string | null; // "campay", "mtn_momo", etc.
  created_at: string;
  updated_at: string;
}

export interface Invoice {
  id: string;
  order_id: string;
  pdf_url: string;
  generated_at: string;
}

// ─── SaaS & Commissions ───────────────────────────────────────────────────────

export interface BrandApplication {
  id: string;
  brand_name: string;
  contact_email: string;
  contact_phone: string;
  status: BrandApplicationStatus;
  rejection_reason: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

export interface BrandDocument {
  id: string;
  application_id: string;
  type: DocumentType;
  url: string;
  is_verified: boolean;
}

export interface Commission {
  id: string;
  payment_id: string;
  order_id: string;
  brand_id: string;
  type: CommissionType;
  rate: number; // 0.02 ou 0.015
  amount: number; // montant prélevé en FCFA
  is_settled: boolean;
  settled_at: string | null;
  created_at: string;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  order_id: string;
  type: ConversationType;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_role: string;
  content: string;
  is_read: boolean;
  created_at: string;
}

// ─── Extras ───────────────────────────────────────────────────────────────────

export interface Promotion {
  id: string;
  brand_id: string;
  code: string;
  type: "percentage" | "fixed";
  value: number;
  min_order: number | null;
  max_uses: number | null;
  uses_count: number;
  expires_at: string | null;
  is_active: boolean;
}

export interface LoyaltyPoints {
  id: string;
  user_id: string;
  points: number;
  updated_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  title_fr: string;
  title_en: string;
  body_fr: string;
  body_en: string;
  type: string;
  data: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string;
}

export interface Review {
  id: string;
  user_id: string;
  product_id: string | null;
  branch_id: string | null;
  rating: number; // 1-5
  comment: string | null;
  created_at: string;
}

export interface ActivityLog {
  id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}
