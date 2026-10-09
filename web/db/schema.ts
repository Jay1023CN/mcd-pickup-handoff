import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const mobileDevices = sqliteTable("mobile_devices", {
  id: text("id").primaryKey(), ownerId: text("owner_id"), tokenHash: text("token_hash").notNull(),
  pairHash: text("pair_hash"), pairExpires: integer("pair_expires").notNull(),
  heartbeat: integer("heartbeat").notNull().default(0), runningJob: text("running_job"),
  lockUntil: integer("lock_until").notNull().default(0), createdAt: integer("created_at").notNull(),
}, (t) => [index("mobile_devices_owner_idx").on(t.ownerId), index("mobile_devices_pair_idx").on(t.pairHash)]);

export const mobileJobs = sqliteTable("mobile_jobs", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), deviceId: text("device_id").notNull(),
  shareId: text("share_id"), action: text("action").notNull(), args: text("args").notNull(),
  state: text("state").notNull(), result: text("result"), error: text("error"),
  createdAt: integer("created_at").notNull(), expiresAt: integer("expires_at").notNull(),
  leaseUntil: integer("lease_until").notNull().default(0),
}, (t) => [
  index("mobile_jobs_queue_idx").on(t.deviceId, t.state, t.createdAt),
  index("mobile_jobs_retention_idx").on(t.expiresAt),
  index("mobile_jobs_share_result_idx").on(t.ownerId, t.deviceId, t.action, t.state, t.createdAt),
  index("mobile_jobs_cleanup_idx").on(t.expiresAt).where(sql`${t.state} IN ('done','failed') AND ${t.result} IS NOT NULL`),
]);

export const mobileShares = sqliteTable("mobile_shares", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), deviceId: text("device_id").notNull(),
  tokenHash: text("token_hash").notNull(), recordId: text("record_id").notNull(),
  card: text("card").notNull(), queriedAt: text("queried_at").notNull(),
  expiresAt: integer("expires_at").notNull(), verified: integer("verified").notNull(),
  revoked: integer("revoked").notNull().default(0), refreshedAt: integer("refreshed_at").notNull().default(0),
}, (t) => [
  index("mobile_shares_owner_history_idx").on(t.ownerId, t.expiresAt),
  index("mobile_shares_retention_idx").on(t.expiresAt),
  index("mobile_shares_cleanup_idx").on(t.expiresAt).where(sql`${t.verified} != 0 OR json_extract(${t.card}, '$.pickup_code') != ''`),
]);

export const mobileRateLimits = sqliteTable("mobile_rate_limits", {
  key: text("key").primaryKey(), count: integer("count").notNull(), expiresAt: integer("expires_at").notNull(),
}, (t) => [index("mobile_rate_limits_cleanup_idx").on(t.expiresAt)]);

export const mobileOwnerSessions = sqliteTable("mobile_owner_sessions", {
  tokenHash: text("token_hash").primaryKey(), ownerId: text("owner_id").notNull(),
  createdAt: integer("created_at").notNull(), expiresAt: integer("expires_at").notNull(),
}, (t) => [index("mobile_owner_sessions_expiry_idx").on(t.expiresAt)]);
