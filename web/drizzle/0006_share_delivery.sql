ALTER TABLE `mobile_shares` ADD `delivery_url` text;--> statement-breakpoint
ALTER TABLE `mobile_shares` ADD `issue_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_shares_issue_identity_idx` ON `mobile_shares` (`owner_id`,`device_id`,`issue_key`) WHERE "mobile_shares"."issue_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `mobile_shares_delivery_cleanup_idx` ON `mobile_shares` (`expires_at`) WHERE "mobile_shares"."delivery_url" IS NOT NULL;--> statement-breakpoint
-- Historical versions could issue the same local record more than once.
-- Mark one canonical row per identity; leave all other rows and public hashes intact.
UPDATE mobile_shares SET issue_key=record_id WHERE id IN (
  SELECT id FROM (
    SELECT s.id, ROW_NUMBER() OVER (
      PARTITION BY s.owner_id,s.device_id,s.record_id
      ORDER BY CASE
        WHEN s.revoked=0 AND s.expires_at>unixepoch()*1000 AND COALESCE(s.progress_step,'')!='collected'
          AND EXISTS(SELECT 1 FROM mobile_jobs j WHERE j.owner_id=s.owner_id AND j.device_id=s.device_id AND j.action='create' AND j.state='done' AND j.expires_at>unixepoch()*1000 AND json_extract(j.result,'$.share.id')=s.id AND json_extract(j.result,'$.share.url') LIKE '/take/'||s.id||'#access=%') THEN 2
        WHEN s.revoked=0 AND s.expires_at>unixepoch()*1000 AND COALESCE(s.progress_step,'')!='collected' THEN 1
        ELSE 0 END DESC, s.expires_at DESC,s.id DESC
    ) AS ordinal FROM mobile_shares s
  ) WHERE ordinal=1
);--> statement-breakpoint
UPDATE mobile_shares SET delivery_url=(
  SELECT json_extract(j.result,'$.share.url') FROM mobile_jobs j
  WHERE j.owner_id=mobile_shares.owner_id AND j.device_id=mobile_shares.device_id
    AND j.action='create' AND j.state='done' AND j.expires_at>unixepoch()*1000
    AND json_extract(j.result,'$.share.id')=mobile_shares.id
    AND json_extract(j.result,'$.share.url') LIKE '/take/'||mobile_shares.id||'#access=%'
  ORDER BY j.created_at DESC LIMIT 1
) WHERE issue_key IS NOT NULL AND revoked=0 AND expires_at>unixepoch()*1000
  AND COALESCE(progress_step,'')!='collected';--> statement-breakpoint
-- Owner delivery is now kept only on the expiring share, not duplicated in jobs.
UPDATE mobile_jobs SET result=json_remove(result,'$.share.url')
  WHERE action='create' AND json_extract(result,'$.share.url') IS NOT NULL;
