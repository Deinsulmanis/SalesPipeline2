-- Stage 3 dedupe: which candidate domains (or company names) already exist as ScaleLab leads.
-- Run READ-ONLY (Supabase connector execute_sql, project lasyefxhuwysjebasdbf) BEFORE any paid step.
-- Replace the two placeholders:
--   :DOMAINS  -> 'acme-staffing.com','beta-labor.com',...   (root + final-redirect + parent domains)
--   :NAMES    -> acme staffing|beta labor|...                (lower-case company-name stems, regex alternation)
-- Any hit is a DUPLICATE (V1, Campaign 2, V2, Industrial Campaign 3, anything ScaleLab), and a
-- suppressed hit (unsubscribe / not interested / bounce / manual hold) must never be re-sourced.
with d as (select unnest(array[:DOMAINS]) dom),
c as (
  select lead_id, left(campaign, 28) campaign, left(company, 45) company, left(stage, 12) stage,
    lower(regexp_replace(regexp_replace(coalesce(website, ''), '^(https?://)?(www\.)?', ''), '[/:?#].*$', '')) wdom,
    lower(split_part(coalesce(email_normalized, email, ''), '@', 2)) edom,
    (notes ~* '\[(REPLY: Unsubscribed|REPLY: Not Interested|BOUNCED|MANUAL HOLD)') suppressed
  from outreach_leads
  where coalesce(client_id, 'scalelab') = 'scalelab'
)
select * from c
where wdom in (select dom from d) or edom in (select dom from d)
   or regexp_replace(lower(company), '[^a-z0-9 ]', ' ', 'g') ~ '\m(:NAMES)\M';
