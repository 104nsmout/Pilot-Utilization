-- =====================================================================
-- Crew Workload — database setup
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run again: every statement checks before creating.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Who may use the app.
--    Why a table instead of "anyone who logs in": Supabase will happily
--    create an account for any email that requests a login link. This
--    list is what actually decides who sees crew data.
-- ---------------------------------------------------------------------
create table if not exists app_users (
  email text primary key,
  role  text not null default 'viewer' check (role in ('viewer', 'admin'))
);

-- Helper checks used by the access rules below. "security definer" lets
-- them read app_users even though normal users can't read that table.
create or replace function is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users
                 where lower(email) = lower(auth.jwt() ->> 'email') and role = 'admin');
$$;

-- ---------------------------------------------------------------------
-- 2. Roster: one row per pilot.
--    name = exactly how Airplane Manager writes it, minus nicknames
--    ("Androl, Garrick David"). That is the join key for every upload.
--    on_board = whether the pilot appears on Greg's board. Pilots from
--    other operations show up in the exports too; they stay hidden.
-- ---------------------------------------------------------------------
create table if not exists roster (
  name         text primary key,
  display_name text,
  base         text,
  on_board     boolean not null default false,
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 3. day_entries: the heart of the app. One row per pilot, per day,
--    per source, per category.
--      source 'legs'     = built from the crew leg export (Flying, Layover)
--      source 'schedule' = built from schedule entries (Training, Travel,
--                          Office, Standby, Sick, Vacation, Other)
--    Each source owns its own rows, so re-uploading flights never wipes
--    out vacation, and vice versa.
-- ---------------------------------------------------------------------
create table if not exists day_entries (
  pilot     text    not null,
  day       date    not null,
  source    text    not null check (source in ('legs', 'schedule')),
  category  text    not null,
  detail    text,
  tail      text,
  legs      int     not null default 0,
  flight_hr numeric(6,2) not null default 0,
  status    text,
  primary key (pilot, day, source, category)
);
create index if not exists day_entries_day_idx on day_entries (day);

-- ---------------------------------------------------------------------
-- 4. uploads: a log of every file you load. The board uses the latest
--    flight upload to show "Data through <date>".
-- ---------------------------------------------------------------------
create table if not exists uploads (
  id          bigint generated always as identity primary key,
  uploaded_at timestamptz not null default now(),
  uploaded_by text,
  source      text not null,
  start_day   date not null,
  end_day     date not null,
  rows_saved  int  not null,
  file_name   text
);

-- ---------------------------------------------------------------------
-- 5. pilot_days view: picks ONE category per pilot per day.
--    If a pilot has a flight and a travel entry on the same day, the
--    flight wins. Lower number = higher priority.
-- ---------------------------------------------------------------------
create or replace view pilot_days with (security_invoker = true) as
select distinct on (pilot, day)
  pilot, day, category, detail, tail, legs, flight_hr, status
from day_entries
order by pilot, day,
  case category
    when 'Flying'   then 1 when 'Training' then 2 when 'Travel'  then 3
    when 'Office'   then 4 when 'Standby'  then 5 when 'Layover' then 6
    when 'Sick'     then 7 when 'Vacation' then 8 else 9
  end;

-- Days where a pilot is shown flying or on a trip but also has vacation or
-- sick logged. Usually a schedule that changed in one place but not the other.
create or replace view day_conflicts with (security_invoker = true) as
select a.pilot, a.day, a.category as trip_category, b.category as time_off_category
from day_entries a
join day_entries b on b.pilot = a.pilot and b.day = a.day
where a.category in ('Flying', 'Layover') and b.category in ('Vacation', 'Sick');

-- ---------------------------------------------------------------------
-- 6. replace_source: the ONLY way data gets written.
--    Why delete-then-insert for the date range instead of just adding:
--    if a trip is cancelled or a vacation is removed in Airplane Manager,
--    the new export simply won't contain it. Clearing the range first is
--    what makes that removal show up on the board. Doing both steps in
--    one function means they succeed or fail together.
-- ---------------------------------------------------------------------
create or replace function replace_source(
  p_source text, p_start date, p_end date, p_rows jsonb, p_file text default null
) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not is_admin() then
    raise exception 'Only admins can upload data.';
  end if;
  if p_source not in ('legs', 'schedule') then
    raise exception 'Unknown source %', p_source;
  end if;

  delete from day_entries where source = p_source and day between p_start and p_end;

  insert into day_entries (pilot, day, source, category, detail, tail, legs, flight_hr, status)
  select r ->> 'pilot', (r ->> 'day')::date, p_source, r ->> 'category', r ->> 'detail', r ->> 'tail',
         coalesce((r ->> 'legs')::int, 0), coalesce((r ->> 'flight_hr')::numeric, 0), r ->> 'status'
  from jsonb_array_elements(p_rows) r
  where (r ->> 'day')::date between p_start and p_end
  on conflict (pilot, day, source, category) do update
    set detail = excluded.detail, tail = excluded.tail, legs = excluded.legs,
        flight_hr = excluded.flight_hr, status = excluded.status;
  get diagnostics n = row_count;

  -- New names go on the roster hidden, so a new hire or a pilot from another
  -- operation never appears on the board until you give them a base.
  insert into roster (name)
  select distinct r ->> 'pilot' from jsonb_array_elements(p_rows) r
  on conflict (name) do nothing;

  insert into uploads (uploaded_by, source, start_day, end_day, rows_saved, file_name)
  values (auth.jwt() ->> 'email', p_source, p_start, p_end, n, p_file);

  return n;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Access rules (Row Level Security).
--    The public "anon" key in the website can't read anything on its
--    own; every read checks is_member(), every write checks is_admin().
-- ---------------------------------------------------------------------
alter table app_users   enable row level security;
alter table roster      enable row level security;
alter table day_entries enable row level security;
alter table uploads     enable row level security;

drop policy if exists "members read roster"   on roster;
drop policy if exists "admins write roster"   on roster;
drop policy if exists "members read days"     on day_entries;
drop policy if exists "members read uploads"  on uploads;
drop policy if exists "admins read users"     on app_users;

create policy "members read roster"  on roster      for select using (is_member());
create policy "admins write roster"  on roster      for all    using (is_admin()) with check (is_admin());
create policy "members read days"    on day_entries for select using (is_member());
create policy "members read uploads" on uploads     for select using (is_member());
create policy "admins read users"    on app_users   for select using (is_admin());
-- No insert/update/delete policies on day_entries or uploads: writes only
-- happen inside replace_source, which checks is_admin() itself.
