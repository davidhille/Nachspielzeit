-- Nachspielzeit: Datenbankschema (Schema "public")
-- Quelle: pg_dump --schema-only vom Backup-Lauf am 24.10.2026, bereinigt um die Altfunktion check_access_code.
-- Der Dump enthält keine Berechtigungen (GRANTs); siehe README.md.
-- Diese Datei ist ein Abbild, keine Migration: bei Schemaänderungen neu aus dem Backup-Dump erzeugen (siehe README.md).

--
-- PostgreSQL database dump
--

\restrict bEzbnQ3jyf1bRV8WRWfKEhC8KEreGC0xq4tZdkdXKYykVto2a5NTG7jMmRqF9CM

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.11 (Ubuntu 17.11-1.pgdg24.04+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: check_access(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_access(code text) RETURNS json
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce(
    (select json_build_object('ok', true, 'team_id', a.team_id) from access_codes a where a.code = check_access.code and a.active limit 1),
    json_build_object('ok', false))
$$;


--
-- Name: nsz_code_ok(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nsz_code_ok(t text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (select 1 from access_codes where code = nsz_header_code() and active and (team_id is null or t is null or team_id = t))
$$;


--
-- Name: nsz_code_ok_arr(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nsz_code_ok_arr(t text[]) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (select 1 from access_codes where code = nsz_header_code() and active and (team_id is null or team_id = any(t)))
$$;


--
-- Name: nsz_header_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nsz_header_code() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select nullif(current_setting('request.headers', true), '')::json ->> 'x-access-code'
$$;


--
-- Name: nsz_is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nsz_is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (select 1 from access_codes where code = nsz_header_code() and active and team_id is null)
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.access_codes (
    code text NOT NULL,
    team_id text,
    label text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: app_features; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_features (
    key text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: basisqualitaet; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.basisqualitaet (
    player_id text NOT NULL,
    wert numeric DEFAULT 0 NOT NULL,
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: entwicklungen; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entwicklungen (
    id text NOT NULL,
    month text NOT NULL,
    player_id text,
    punkte numeric DEFAULT 0 NOT NULL,
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: gegner; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gegner (
    id text NOT NULL,
    name text NOT NULL,
    deleted_at timestamp with time zone,
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: material_bestand; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.material_bestand (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    date date NOT NULL,
    material text NOT NULL,
    menge integer NOT NULL,
    gruppe text,
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: players; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.players (
    id text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    deleted_at timestamp with time zone,
    photo_url text,
    trikotnummer integer,
    nachname text,
    geburtsdatum date,
    passnummer text,
    team_id text DEFAULT 'u8'::text NOT NULL,
    spitzname text
);


--
-- Name: spiele; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spiele (
    id text NOT NULL,
    spieltag_id text,
    opponent_id text,
    our_goals integer DEFAULT 0 NOT NULL,
    their_goals integer DEFAULT 0 NOT NULL,
    team_id text DEFAULT 'u8'::text NOT NULL,
    torfolge jsonb
);


--
-- Name: spieltag_gegner; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spieltag_gegner (
    spieltag_id text NOT NULL,
    opponent_id text NOT NULL,
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: spieltag_teilnehmer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spieltag_teilnehmer (
    spieltag_id text NOT NULL,
    player_id text NOT NULL,
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: spieltage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spieltage (
    id text NOT NULL,
    date date NOT NULL,
    deleted_at timestamp with time zone,
    notizen text,
    foto_url text,
    zeit text,
    typ text DEFAULT 'spieltag'::text,
    ort text,
    spielzeit_min integer,
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: taktik_boards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.taktik_boards (
    id text NOT NULL,
    team_id text DEFAULT 'u8'::text NOT NULL,
    name text DEFAULT 'Neues Board'::text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    deleted_at timestamp with time zone
);


--
-- Name: team_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_settings (
    id integer DEFAULT 1 NOT NULL,
    team_photo_url text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id text NOT NULL,
    name text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: torschuetzen; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.torschuetzen (
    id text NOT NULL,
    spiel_id text,
    player_id text,
    tore integer DEFAULT 1 NOT NULL,
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: training_boards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_boards (
    id text NOT NULL,
    team_id text DEFAULT 'u8'::text NOT NULL,
    termin_id text NOT NULL,
    board_id text NOT NULL,
    "position" integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: training_uebungen; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.training_uebungen (
    id text NOT NULL,
    termin_id text NOT NULL,
    uebung_id text NOT NULL,
    "position" integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: trainings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trainings (
    id text NOT NULL,
    date date NOT NULL,
    player_id text,
    vorkommnis numeric DEFAULT 0 NOT NULL,
    karte text DEFAULT 'keine'::text NOT NULL,
    teilnahme text DEFAULT 'anwesend'::text NOT NULL,
    kommentar text DEFAULT ''::text,
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: trainingstermine; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trainingstermine (
    id text NOT NULL,
    date date NOT NULL,
    status text DEFAULT 'geplant'::text NOT NULL,
    typ text DEFAULT 'training'::text NOT NULL,
    start_zeit text,
    end_zeit text,
    notizen text,
    bewertung_notizen text,
    team_id text DEFAULT 'u8'::text NOT NULL
);


--
-- Name: uebungen; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.uebungen (
    id text NOT NULL,
    titel text NOT NULL,
    beschreibung text,
    dauer integer,
    kinder text,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    material text[] DEFAULT '{}'::text[] NOT NULL,
    bild_url text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    team_id text DEFAULT 'u8'::text NOT NULL,
    team_ids text[] DEFAULT '{u8}'::text[] NOT NULL
);


--
-- Name: access_codes access_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.access_codes
    ADD CONSTRAINT access_codes_pkey PRIMARY KEY (code);


--
-- Name: app_features app_features_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_features
    ADD CONSTRAINT app_features_pkey PRIMARY KEY (team_id, key);


--
-- Name: basisqualitaet basisqualitaet_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.basisqualitaet
    ADD CONSTRAINT basisqualitaet_pkey PRIMARY KEY (player_id);


--
-- Name: entwicklungen entwicklungen_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entwicklungen
    ADD CONSTRAINT entwicklungen_pkey PRIMARY KEY (id);


--
-- Name: gegner gegner_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gegner
    ADD CONSTRAINT gegner_pkey PRIMARY KEY (id);


--
-- Name: material_bestand material_bestand_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_bestand
    ADD CONSTRAINT material_bestand_pkey PRIMARY KEY (id);


--
-- Name: material_bestand material_bestand_team_date_material_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.material_bestand
    ADD CONSTRAINT material_bestand_team_date_material_key UNIQUE (team_id, date, material);


--
-- Name: players players_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.players
    ADD CONSTRAINT players_pkey PRIMARY KEY (id);


--
-- Name: spiele spiele_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spiele
    ADD CONSTRAINT spiele_pkey PRIMARY KEY (id);


--
-- Name: spieltag_gegner spieltag_gegner_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spieltag_gegner
    ADD CONSTRAINT spieltag_gegner_pkey PRIMARY KEY (spieltag_id, opponent_id);


--
-- Name: spieltag_teilnehmer spieltag_teilnehmer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spieltag_teilnehmer
    ADD CONSTRAINT spieltag_teilnehmer_pkey PRIMARY KEY (spieltag_id, player_id);


--
-- Name: spieltage spieltage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spieltage
    ADD CONSTRAINT spieltage_pkey PRIMARY KEY (id);


--
-- Name: taktik_boards taktik_boards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.taktik_boards
    ADD CONSTRAINT taktik_boards_pkey PRIMARY KEY (id);


--
-- Name: team_settings team_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_settings
    ADD CONSTRAINT team_settings_pkey PRIMARY KEY (id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: torschuetzen torschuetzen_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.torschuetzen
    ADD CONSTRAINT torschuetzen_pkey PRIMARY KEY (id);


--
-- Name: training_boards training_boards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_boards
    ADD CONSTRAINT training_boards_pkey PRIMARY KEY (id);


--
-- Name: training_uebungen training_uebungen_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.training_uebungen
    ADD CONSTRAINT training_uebungen_pkey PRIMARY KEY (id);


--
-- Name: trainings trainings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trainings
    ADD CONSTRAINT trainings_pkey PRIMARY KEY (id);


--
-- Name: trainingstermine trainingstermine_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trainingstermine
    ADD CONSTRAINT trainingstermine_pkey PRIMARY KEY (id);


--
-- Name: uebungen uebungen_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.uebungen
    ADD CONSTRAINT uebungen_pkey PRIMARY KEY (id);


--
-- Name: basisqualitaet basisqualitaet_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.basisqualitaet
    ADD CONSTRAINT basisqualitaet_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;


--
-- Name: entwicklungen entwicklungen_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entwicklungen
    ADD CONSTRAINT entwicklungen_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;


--
-- Name: spiele spiele_opponent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spiele
    ADD CONSTRAINT spiele_opponent_id_fkey FOREIGN KEY (opponent_id) REFERENCES public.gegner(id);


--
-- Name: spiele spiele_spieltag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spiele
    ADD CONSTRAINT spiele_spieltag_id_fkey FOREIGN KEY (spieltag_id) REFERENCES public.spieltage(id) ON DELETE CASCADE;


--
-- Name: spieltag_gegner spieltag_gegner_opponent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spieltag_gegner
    ADD CONSTRAINT spieltag_gegner_opponent_id_fkey FOREIGN KEY (opponent_id) REFERENCES public.gegner(id) ON DELETE CASCADE;


--
-- Name: spieltag_gegner spieltag_gegner_spieltag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spieltag_gegner
    ADD CONSTRAINT spieltag_gegner_spieltag_id_fkey FOREIGN KEY (spieltag_id) REFERENCES public.spieltage(id) ON DELETE CASCADE;


--
-- Name: spieltag_teilnehmer spieltag_teilnehmer_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spieltag_teilnehmer
    ADD CONSTRAINT spieltag_teilnehmer_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;


--
-- Name: spieltag_teilnehmer spieltag_teilnehmer_spieltag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spieltag_teilnehmer
    ADD CONSTRAINT spieltag_teilnehmer_spieltag_id_fkey FOREIGN KEY (spieltag_id) REFERENCES public.spieltage(id) ON DELETE CASCADE;


--
-- Name: torschuetzen torschuetzen_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.torschuetzen
    ADD CONSTRAINT torschuetzen_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id);


--
-- Name: torschuetzen torschuetzen_spiel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.torschuetzen
    ADD CONSTRAINT torschuetzen_spiel_id_fkey FOREIGN KEY (spiel_id) REFERENCES public.spiele(id) ON DELETE CASCADE;


--
-- Name: trainings trainings_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trainings
    ADD CONSTRAINT trainings_player_id_fkey FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE CASCADE;


--
-- Name: app_features access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.app_features USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: basisqualitaet access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.basisqualitaet USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: entwicklungen access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.entwicklungen USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: gegner access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.gegner USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: material_bestand access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.material_bestand USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: players access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.players USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: spiele access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.spiele USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: spieltag_gegner access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.spieltag_gegner USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: spieltag_teilnehmer access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.spieltag_teilnehmer USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: spieltage access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.spieltage USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: taktik_boards access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.taktik_boards USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: team_settings access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.team_settings USING (public.nsz_code_ok()) WITH CHECK (public.nsz_code_ok());


--
-- Name: torschuetzen access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.torschuetzen USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: training_boards access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.training_boards USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: training_uebungen access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.training_uebungen USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: trainings access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.trainings USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: trainingstermine access via code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "access via code" ON public.trainingstermine USING (public.nsz_code_ok(team_id)) WITH CHECK (public.nsz_code_ok(team_id));


--
-- Name: access_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.access_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: app_features; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_features ENABLE ROW LEVEL SECURITY;

--
-- Name: basisqualitaet; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.basisqualitaet ENABLE ROW LEVEL SECURITY;

--
-- Name: entwicklungen; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entwicklungen ENABLE ROW LEVEL SECURITY;

--
-- Name: gegner; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gegner ENABLE ROW LEVEL SECURITY;

--
-- Name: material_bestand; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.material_bestand ENABLE ROW LEVEL SECURITY;

--
-- Name: access_codes nur admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "nur admin" ON public.access_codes USING (public.nsz_is_admin()) WITH CHECK (public.nsz_is_admin());


--
-- Name: players; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;

--
-- Name: spiele; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.spiele ENABLE ROW LEVEL SECURITY;

--
-- Name: spieltag_gegner; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.spieltag_gegner ENABLE ROW LEVEL SECURITY;

--
-- Name: spieltag_teilnehmer; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.spieltag_teilnehmer ENABLE ROW LEVEL SECURITY;

--
-- Name: spieltage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.spieltage ENABLE ROW LEVEL SECURITY;

--
-- Name: taktik_boards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.taktik_boards ENABLE ROW LEVEL SECURITY;

--
-- Name: team_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.team_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: teams; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

--
-- Name: teams teams aendern; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "teams aendern" ON public.teams FOR UPDATE USING (public.nsz_code_ok(id)) WITH CHECK (public.nsz_code_ok(id));


--
-- Name: teams teams anlegen; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "teams anlegen" ON public.teams FOR INSERT WITH CHECK (public.nsz_is_admin());


--
-- Name: teams teams lesen; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "teams lesen" ON public.teams FOR SELECT USING (public.nsz_code_ok());


--
-- Name: teams teams loeschen; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "teams loeschen" ON public.teams FOR DELETE USING (public.nsz_is_admin());


--
-- Name: torschuetzen; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.torschuetzen ENABLE ROW LEVEL SECURITY;

--
-- Name: training_boards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.training_boards ENABLE ROW LEVEL SECURITY;

--
-- Name: training_uebungen; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.training_uebungen ENABLE ROW LEVEL SECURITY;

--
-- Name: trainings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trainings ENABLE ROW LEVEL SECURITY;

--
-- Name: trainingstermine; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trainingstermine ENABLE ROW LEVEL SECURITY;

--
-- Name: uebungen; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.uebungen ENABLE ROW LEVEL SECURITY;

--
-- Name: uebungen uebungen aendern; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "uebungen aendern" ON public.uebungen FOR UPDATE USING (public.nsz_code_ok_arr(team_ids)) WITH CHECK (public.nsz_code_ok_arr(team_ids));


--
-- Name: uebungen uebungen anlegen; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "uebungen anlegen" ON public.uebungen FOR INSERT WITH CHECK (public.nsz_code_ok_arr(team_ids));


--
-- Name: uebungen uebungen lesen; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "uebungen lesen" ON public.uebungen FOR SELECT USING ((public.nsz_code_ok_arr(team_ids) OR (('alle'::text = ANY (team_ids)) AND public.nsz_code_ok())));


--
-- Name: uebungen uebungen loeschen; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "uebungen loeschen" ON public.uebungen FOR DELETE USING (public.nsz_code_ok_arr(team_ids));


--
-- PostgreSQL database dump complete
--

\unrestrict bEzbnQ3jyf1bRV8WRWfKEhC8KEreGC0xq4tZdkdXKYykVto2a5NTG7jMmRqF9CM


-- ======================================================================
-- Ergänzung nach dem Dump vom 24.10.2026: anonymes Fehlerprotokoll
-- (im Dump noch nicht enthalten; das SQL steht auch in der App unter Administration -> Fehler)
-- ======================================================================
-- Nachspielzeit: anonymes Fehlerprotokoll (wiederholbar)
create table if not exists fehlerprotokoll (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  team_id text not null,
  kontext text not null check (char_length(kontext) <= 20),
  bereich text check (char_length(bereich) <= 40),
  meldung text not null check (char_length(meldung) <= 300),
  stack text check (char_length(stack) <= 600),
  stand text check (char_length(stand) <= 20),
  geraet text check (char_length(geraet) <= 40)
);
alter table fehlerprotokoll enable row level security;
grant select, insert, delete on table fehlerprotokoll to anon, authenticated, service_role;
drop policy if exists "fehler eintragen" on fehlerprotokoll;
drop policy if exists "fehler lesen" on fehlerprotokoll;
drop policy if exists "fehler loeschen" on fehlerprotokoll;
-- Eintragen: jeder gültige Code für sein Team. Lesen und Löschen: nur Admin-Codes.
create policy "fehler eintragen" on fehlerprotokoll for insert to public with check (nsz_code_ok(team_id));
create policy "fehler lesen" on fehlerprotokoll for select to public using (nsz_is_admin());
create policy "fehler loeschen" on fehlerprotokoll for delete to public using (nsz_is_admin());
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Storage-Regeln (Bucket profilbilder), Stand 24.10.2026 aus pg_policies.
-- Der Bucket selbst (öffentlich) wird im Supabase-Dashboard angelegt.
-- ---------------------------------------------------------------------------
drop policy if exists "profilbilder lesen" on storage.objects;
drop policy if exists "profilbilder schreiben" on storage.objects;
drop policy if exists "profilbilder aendern" on storage.objects;
drop policy if exists "profilbilder loeschen" on storage.objects;
create policy "profilbilder lesen" on storage.objects for select
  using (bucket_id = 'profilbilder' and nsz_storage_ok(name));
create policy "profilbilder schreiben" on storage.objects for insert
  with check (bucket_id = 'profilbilder' and nsz_storage_ok(name));
create policy "profilbilder aendern" on storage.objects for update
  using (bucket_id = 'profilbilder' and nsz_storage_ok(name))
  with check (bucket_id = 'profilbilder' and nsz_storage_ok(name));
create policy "profilbilder loeschen" on storage.objects for delete
  using (bucket_id = 'profilbilder' and nsz_storage_ok(name));

-- ======================================================================
-- Ergänzung 30.10.2026: Briefkasten (anonymes Eltern-Feedback, SVH-6)
-- ======================================================================
-- Nachspielzeit: Briefkasten, anonymes Eltern-Feedback (wiederholbar)
create table if not exists briefkasten (
  id bigint generated always as identity primary key,
  team_id text not null,
  -- bewusst nur auf die Stunde genau gespeichert (Anonymität); angezeigt wird nur das Datum
  created_at timestamptz not null default date_trunc('hour', now()),
  nachricht text not null check (char_length(nachricht) between 1 and 1000),
  kategorie text not null default 'sonstiges' check (kategorie in ('lob', 'kritik', 'idee', 'sonstiges')),
  status text not null default 'neu' check (status in ('neu', 'gelesen', 'erledigt')),
  deleted_at timestamptz
);
create index if not exists briefkasten_team_idx on briefkasten (team_id, created_at desc);
alter table briefkasten enable row level security;
grant select, insert, update, delete on table briefkasten to anon, authenticated, service_role;
drop policy if exists "access via code" on briefkasten;
-- Lesen/Ändern nur mit Zugangscode des Teams (Trainer-App). Eltern schreiben nur über die Funktion unten.
create policy "access via code" on briefkasten for all to public using (nsz_code_ok(team_id)) with check (nsz_code_ok(team_id));

create or replace function briefkasten_senden(p_token text, p_nachricht text, p_kategorie text default 'sonstiges', p_website text default '')
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_team text;
  v_text text := btrim(coalesce(p_nachricht, ''));
  v_kat text := case when p_kategorie in ('lob', 'kritik', 'idee', 'sonstiges') then p_kategorie else 'sonstiges' end;
begin
  -- Honeypot: Bots füllen das versteckte Feld, wir tun so, als wäre alles gut
  if coalesce(p_website, '') <> '' then return 'ok'; end if;
  if coalesce(p_token, '') = '' then return 'ungueltig'; end if;
  select id into v_team from teams where config ->> 'share_token' = p_token and not archived limit 1;
  if v_team is null then return 'ungueltig'; end if;
  -- Briefkasten ist standardmäßig aus: nur mit ausdrücklich eingeschaltetem Schalter
  if not exists (select 1 from app_features where team_id = v_team and key = 'eltern_briefkasten' and enabled) then return 'aus'; end if;
  if exists (select 1 from app_features where team_id = v_team and key = 'eltern_seite' and not enabled) then return 'aus'; end if;
  if char_length(v_text) < 1 or char_length(v_text) > 1000 then return 'laenge'; end if;
  -- Bremse gegen Spam: höchstens 20 Nachrichten pro Stunde und Team
  if (select count(*) from briefkasten where team_id = v_team and created_at = date_trunc('hour', now())) >= 20 then return 'zu_viele'; end if;
  insert into briefkasten (team_id, nachricht, kategorie) values (v_team, v_text, v_kat);
  return 'ok';
end
$$;
revoke all on function briefkasten_senden(text, text, text, text) from public;
grant execute on function briefkasten_senden(text, text, text, text) to anon, authenticated, service_role;
notify pgrst, 'reload schema';

-- ======================================================================
-- Ergänzung 30.10.2026: Notizbuch (freie Trainer-Notizen)
-- ======================================================================
create table if not exists notizen (
  id bigint generated always as identity primary key,
  team_id text not null,
  titel text not null default '' check (char_length(titel) <= 120),
  inhalt text not null default '' check (char_length(inhalt) <= 10000),
  kategorie text not null default 'sonstiges' check (kategorie in ('orga', 'ideen', 'eltern', 'sonstiges')),
  angepinnt boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists notizen_team_idx on notizen (team_id, updated_at desc);
alter table notizen enable row level security;
grant select, insert, update, delete on table notizen to anon, authenticated, service_role;
drop policy if exists "access via code" on notizen;
create policy "access via code" on notizen for all to public using (nsz_code_ok(team_id)) with check (nsz_code_ok(team_id));
notify pgrst, 'reload schema';

-- ======================================================================
-- Ergänzung 30.10.2026: Wechsel-Erinnerung pro Spieltag
-- (null = Teamstandard, 0 = aus, sonst Minuten)
-- ======================================================================
alter table public.spieltage add column if not exists wechsel_min integer check (wechsel_min is null or (wechsel_min between 0 and 45));
notify pgrst, 'reload schema';

-- ======================================================================
-- Ergänzung 30.10.2026: Vereine als eigene Ebene über den Teams
-- (wiederholbar; die App läuft auch vor dem Ausführen mit den alten Werten aus teams.config weiter)
-- ======================================================================
create table if not exists vereine (
  id text primary key check (id ~ '^[a-z0-9-]{2,40}$'),
  name text not null check (char_length(name) between 1 and 80),
  logo_url text,
  created_at timestamptz not null default now()
);
alter table vereine enable row level security;
grant select, insert, update, delete on table vereine to anon, authenticated, service_role;
drop policy if exists "vereine lesen" on vereine;
drop policy if exists "vereine schreiben" on vereine;
-- Lesen: jeder gültige Zugangscode (Name und Wappen erscheinen in der Trainer-App). Ändern: nur Admin-Codes.
create policy "vereine lesen" on vereine for select to public using (nsz_code_ok());
create policy "vereine schreiben" on vereine for all to public using (nsz_is_admin()) with check (nsz_is_admin());

alter table teams add column if not exists verein_id text references vereine(id) on update cascade on delete set null;

-- Bestehende Daten übernehmen: Standardverein aus den bisherigen Einstellungen des ersten Teams, alle Teams ohne Verein werden ihm zugeordnet
insert into vereine (id, name, logo_url)
select 'sv-heimstetten',
       coalesce((select nullif(config ->> 'verein_name', '') from teams where nullif(config ->> 'verein_name', '') is not null order by created_at limit 1), 'SV Heimstetten'),
       (select nullif(config ->> 'verein_logo_url', '') from teams where nullif(config ->> 'verein_logo_url', '') is not null order by created_at limit 1)
on conflict (id) do nothing;
update teams set verein_id = 'sv-heimstetten' where verein_id is null;
notify pgrst, 'reload schema';


-- ============================================================
-- Team endgültig löschen (30.10.2026)
-- Nur Haupt-Admin, nur für archivierte Teams, nicht für 'u8'. Wiederholbar.
-- ============================================================
create or replace function public.team_loeschen(p_team text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare t text;
begin
  if not nsz_is_admin() then raise exception 'Nur ein Admin-Code darf Teams löschen.'; end if;
  if p_team is null or p_team = 'u8' then raise exception 'Dieses Team darf nicht gelöscht werden.'; end if;
  if not exists (select 1 from teams where id = p_team and archived) then raise exception 'Das Team muss zuerst archiviert werden.'; end if;
  -- Kindtabellen zuerst, dann Elterntabellen
  foreach t in array array['torschuetzen','spiele','spieltag_teilnehmer','spieltag_gegner','spieltage','training_uebungen','trainings','entwicklungen','basisqualitaet','trainingstermine','players','gegner','material_bestand','app_features','taktik_boards','training_boards','briefkasten','notizen'] loop
    if to_regclass('public.' || t) is not null then
      execute format('delete from public.%I where team_id = $1', t) using p_team;
    end if;
  end loop;
  -- Übungen: gehörte sie nur diesem Team, weg; sonst nur das Team aus der Liste nehmen
  delete from uebungen where team_ids = array[p_team];
  update uebungen set team_ids = array_remove(team_ids, p_team) where p_team = any(team_ids);
  delete from access_codes where team_id = p_team;
  delete from teams where id = p_team;
end $$;
grant execute on function public.team_loeschen(text) to anon, authenticated, service_role;
notify pgrst, 'reload schema';
