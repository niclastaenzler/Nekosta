-- Testschema mit denselben Beziehungen wie NEKOSTA (nur für automatische Tests)
create table objekte (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid() references auth.users(id), name text, strasse text, kategorie text, created_at timestamptz default now());
create table einheiten (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid(), objekt_id uuid references objekte(id) on delete cascade, bezeichnung text, flaeche numeric);
create table kontakte (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid(), anrede text, vorname text, nachname text, email text);
create table mietverhaeltnisse (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid(), objekt_id uuid references objekte(id), einheit_id uuid references einheiten(id), kontakt_id uuid references kontakte(id), aktiv boolean default true, auszug date, kaltmiete numeric);
create table mietverhaeltnis_mieter (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid(), mietverhaeltnis_id uuid references mietverhaeltnisse(id) on delete cascade, kontakt_id uuid references kontakte(id));
create table stammdaten (user_id uuid primary key default auth.uid(), firma text, briefkopf text, gruss_text text);
create table weg_einheit_personen (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid(), einheit_id uuid, jahr int, monat int, personen int, unique(einheit_id, jahr, monat));
create table settings_json (id uuid primary key default gen_random_uuid(), user_id uuid not null default auth.uid(), mitglieder jsonb default '[]'::jsonb, tags text[]);

do $$ declare t text; begin
  foreach t in array array['objekte','einheiten','kontakte','mietverhaeltnisse','mietverhaeltnis_mieter','stammdaten','weg_einheit_personen','settings_json'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy own on %I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

create policy dok_own on storage.objects for all to authenticated
  using (bucket_id = 'dokumente' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'dokumente' and (storage.foldername(name))[1] = auth.uid()::text);
