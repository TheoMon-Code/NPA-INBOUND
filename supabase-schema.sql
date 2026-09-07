-- MON Inbound — Supabase schema
-- Run this once in your Supabase project's SQL editor (Database > SQL Editor > New query),
-- then paste it in and click "Run". It creates the two tables the app needs and opens them
-- up to the anon (public) key, which is what a no-login mobile app like this one uses.
--
-- IMPORTANT — security note (read this): this schema grants the anon key full read/write
-- access to both tables and to the storage bucket, with no authentication at all. That is
-- fine for this test/mockup (no login was ever part of the brief), but it means anyone who
-- has your anon key (which is visible in index.html, since it ships to every phone) can read
-- and write every truck and every photo. Do not put anything sensitive in this project, and
-- treat it as a prototype, not a production system, until real auth/RLS rules are added.

-- ---------- trucks ----------
create table if not exists public.trucks (
  id uuid primary key default gen_random_uuid(),
  reference_id text,                 -- short display code, e.g. "T-LMPQR2" (app-generated)
  carrier text,
  plant text,
  im_ex_tr text,                     -- IM / EX / TR
  po_no text,
  sku_no text,
  qtt text,
  cont_no text,
  seal_no text,
  cont_type text,
  closing_date text,
  remark text,
  details text,                      -- product / description
  order_date date not null,          -- the day this truck is scheduled for (drives the Yesterday/Today/Tomorrow tabs)
  eta timestamp,                     -- theoretical arrival time, entered the day before (naive local time, no timezone)
  truck_state text not null default 'pending' check (truck_state in ('pending','arrived','completed')),
  act_arrival timestamp,             -- set when the MHE driver taps "Start Unloading"
  act_dept timestamp,                -- set when the MHE driver taps "Finish Unloading"
  started_by text,
  finished_by text,
  raw jsonb,                         -- every column the "Import inbound plan" feature saw for this
                                      -- truck in the source file, verbatim (keyed by the file's own
                                      -- column headers) — catches details with no dedicated column
                                      -- above (weighing, gross weight, on-time flags, penalties…) so
                                      -- nothing from the source file is ever silently dropped. Only
                                      -- populated for trucks created via that import; manually added
                                      -- trucks leave this null. Shown in the app under a truck's
                                      -- "All imported fields" section. Holds the FIRST lot's raw data
                                      -- when a truck has several (see `lots` below).
  lots jsonb,                         -- one physical truck can carry several lots/line-items on the
                                      -- same source-file PO+date+time+carrier (confirmed against a
                                      -- real "Incoming plan" file: e.g. one PO delivered as two
                                      -- separate line items). Each element is
                                      -- {details, qtt, sku_no, remark, raw} for one lot; `details`/
                                      -- `qtt`/`sku_no`/`remark`/`raw` above always mirror lots[0] so a
                                      -- single-lot truck (the common case) looks exactly as before.
                                      -- Only populated for imported trucks with more than one lot;
                                      -- null otherwise.
  damage_remark text,                 -- one free-text note per truck, set by the driver/admin from the
                                      -- app itself (not from the source file) — e.g. which layer of the
                                      -- container damaged product was found on, used as evidence for a
                                      -- supplier claim. Editable any time, independent of `remark` above
                                      -- (which is read-only data copied from the imported source file).
  created_at timestamptz not null default now()
);
-- Running this file again on a project that already has the table (e.g. you
-- ran it before "raw"/"lots"/"damage_remark" existed) needs these explicit
-- ALTERs — "create table if not exists" above is a no-op once the table is
-- already there, so it can't add new columns on its own.
alter table public.trucks add column if not exists raw jsonb;
alter table public.trucks add column if not exists lots jsonb;
alter table public.trucks add column if not exists damage_remark text;

-- ---------- photos ----------
-- Up to MAX_PHOTOS_PER_TRUCK (js/config.js — currently 40) photos per truck,
-- addable at any time, in no particular order.
create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  truck_id uuid not null references public.trucks(id) on delete cascade,
  url text not null,                 -- public Storage URL, ready to use as-is
  storage_path text not null,        -- path inside the bucket, needed to delete the file later
  uploaded_by text,
  created_at timestamptz not null default now()
);
create index if not exists photos_truck_id_idx on public.photos(truck_id);

-- ---------- row level security ----------
-- RLS is ON, with permissive policies for the anon key (see the security note above).
alter table public.trucks enable row level security;
alter table public.photos enable row level security;

drop policy if exists "anon full access trucks" on public.trucks;
create policy "anon full access trucks" on public.trucks
  for all using (true) with check (true);

drop policy if exists "anon full access photos" on public.photos;
create policy "anon full access photos" on public.photos
  for all using (true) with check (true);

-- ---------- storage bucket for photos ----------
-- Creates a public bucket named "inbound-photos" (must match SUPABASE_BUCKET in index.html).
insert into storage.buckets (id, name, public)
values ('inbound-photos', 'inbound-photos', true)
on conflict (id) do nothing;

drop policy if exists "anon full access inbound-photos" on storage.objects;
create policy "anon full access inbound-photos" on storage.objects
  for all using (bucket_id = 'inbound-photos') with check (bucket_id = 'inbound-photos');

-- ---------- optional: a few test rows ----------
-- Uncomment and run to see some data in the app right away.
-- insert into public.trucks (reference_id, carrier, plant, im_ex_tr, po_no, sku_no, qtt, details, order_date, eta, truck_state)
-- values
--   ('T-DEMO1', 'Aurora Freight Line', 'Plant 1', 'IM', 'PO-10021', 'SKU-2210', '480 pcs', 'Aluminum brackets', current_date, (current_date + time '09:00'), 'pending'),
--   ('T-DEMO2', 'Meridian Cargo Co.', 'Plant 2', 'EX', 'PO-10034', 'SKU-2244', '1200 pcs', 'Packaging film', current_date, (current_date + time '13:30'), 'pending');
