-- ============================================================================
-- Discontinuity Protocol — Supabase / PostgreSQL schema
-- ----------------------------------------------------------------------------
-- Data-protection note, read before deploying:
--
-- This schema is PSEUDONYMISED, NOT ANONYMOUS. A reversibly encrypted mobile
-- number is personal data under UK/EU GDPR, and so is the keyed hash of it.
-- Do not describe this store as "zero PII" in marketing, contracts or a DPIA.
-- The correct description is: "no name, no email, no address; mobile number
-- held encrypted at rest with a key held outside the database."
--
-- Access model: every table is RLS-enabled with NO policies, so the anon and
-- authenticated roles can read nothing even if the publishable key leaks. The
-- Worker connects with the service_role key, which bypasses RLS by design and
-- is therefore stored only as a Cloudflare secret.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Table 1: Activation tokens. Rows are generated before the ledgers are printed;
-- one printed code per ledger. Only a keyed HMAC of the code is stored, so a
-- database dump does not yield usable codes (an unkeyed SHA-256 of a short code
-- is brute-forceable in seconds).
-- ---------------------------------------------------------------------------
CREATE TABLE public.activation_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hmac    CHAR(64)    NOT NULL UNIQUE,
    batch_ref     TEXT,
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    claimed_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Table 2: Participant sessions.
--   public_code   short opaque code used in SMS links, so session UUIDs never
--                 travel in a URL, a browser history or an HTTP referrer.
--   phone_hmac    keyed hash for duplicate detection and inbound-SMS lookup.
--                 An unkeyed hash of a phone number is trivially reversible:
--                 the whole UK mobile space is about 10^9 candidates.
--
-- What is deliberately NOT here: the behaviour being discontinued. The SRBAI
-- items all refer to one action, so a fixed referent is essential to the
-- measurement, but it does not have to live in this database to be fixed. The
-- participant writes it on page 1 of their ledger and the weekly page points
-- them back to it. Storing it instead would put free text about someone's
-- drinking, vaping, scrolling or gambling next to their mobile number, which is
-- more sensitive than every other column here combined.
-- ---------------------------------------------------------------------------
CREATE TABLE public.participant_sessions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    public_code       CHAR(12)    NOT NULL UNIQUE,
    token_hmac        CHAR(64)    NOT NULL UNIQUE
                      REFERENCES public.activation_tokens(token_hmac),
    phone_hmac        CHAR(64)    NOT NULL,
    encrypted_phone   TEXT        NOT NULL,
    baseline_score    SMALLINT    NOT NULL CHECK (baseline_score BETWEEN 4 AND 28),
    dispatch_week     SMALLINT    NOT NULL DEFAULT 0
                      CHECK (dispatch_week BETWEEN 0 AND 13),
    is_graduated      BOOLEAN     NOT NULL DEFAULT FALSE,
    graduated_at      TIMESTAMPTZ,
    -- PECR / Twilio compliance: an inbound STOP sets this and halts all dispatch.
    sms_opted_out     BOOLEAN     NOT NULL DEFAULT FALSE,
    opted_out_at      TIMESTAMPTZ,
    consent_recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live session per number. Prevents one person burning several ledgers onto
-- the same handset and receiving overlapping, contradictory pulse messages.
--
-- dispatch_week < 13 is part of the predicate on purpose. Without it, a
-- participant who runs the full protocol and does not reach the exit threshold
-- stays "active" for ever and can never buy a second ledger, which is exactly
-- the customer most likely to want one.
CREATE UNIQUE INDEX uq_sessions_active_phone
    ON public.participant_sessions (phone_hmac)
    WHERE is_graduated = FALSE AND sms_opted_out = FALSE AND dispatch_week < 13;

-- ---------------------------------------------------------------------------
-- Table 3: Automaticity logs. Week 0 is the Day-0 baseline; weeks 1-12 are the
-- weekly pulses; week 13 is the Day-91 exit audit.
--
-- The instrument is the SRBAI (Gardner, Abraham, Lally & de Bruijn, 2012), a
-- 4-item automaticity index. It is NOT the SRHI, which has 12 items. Column
-- names say so, because mislabelling the instrument is the fastest way to lose
-- an evidence-led positioning.
-- ---------------------------------------------------------------------------
CREATE TABLE public.srbai_logs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   UUID        NOT NULL
                 REFERENCES public.participant_sessions(id) ON DELETE CASCADE,
    week_number  SMALLINT    NOT NULL CHECK (week_number BETWEEN 0 AND 13),
    q1_score     SMALLINT    NOT NULL CHECK (q1_score BETWEEN 1 AND 7),
    q2_score     SMALLINT    NOT NULL CHECK (q2_score BETWEEN 1 AND 7),
    q3_score     SMALLINT    NOT NULL CHECK (q3_score BETWEEN 1 AND 7),
    q4_score     SMALLINT    NOT NULL CHECK (q4_score BETWEEN 1 AND 7),
    total_score  SMALLINT    NOT NULL CHECK (total_score BETWEEN 4 AND 28),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The total must agree with its parts. Without this a caller can post any
    -- total it likes and fake a graduation.
    CONSTRAINT total_matches_items
        CHECK (total_score = q1_score + q2_score + q3_score + q4_score),
    -- One log per week per session. Without this, a resubmitted week counts
    -- twice and satisfies the "consecutive weeks" graduation test on its own.
    CONSTRAINT uq_log_session_week UNIQUE (session_id, week_number)
);

-- ---------------------------------------------------------------------------
-- Table 4: Dispatch ledger. Makes the weekly send idempotent, so a cron retry
-- or a double-fire cannot text a participant twice.
-- ---------------------------------------------------------------------------
CREATE TABLE public.dispatch_log (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id   UUID        NOT NULL
                 REFERENCES public.participant_sessions(id) ON DELETE CASCADE,
    week_number  SMALLINT    NOT NULL CHECK (week_number BETWEEN 1 AND 13),
    delivered    BOOLEAN     NOT NULL DEFAULT FALSE,
    dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_dispatch_session_week UNIQUE (session_id, week_number)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX idx_logs_session_week   ON public.srbai_logs (session_id, week_number DESC);
CREATE INDEX idx_sessions_phone_hmac ON public.participant_sessions (phone_hmac);
CREATE INDEX idx_sessions_due        ON public.participant_sessions (dispatch_week)
    WHERE is_graduated = FALSE AND sms_opted_out = FALSE;

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled everywhere, no policies anywhere.
-- Effect: anon and authenticated roles can do nothing. service_role bypasses
-- RLS, which is why the service key lives only in Cloudflare secrets.
-- ---------------------------------------------------------------------------
ALTER TABLE public.activation_tokens    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.srbai_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_log         ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.activation_tokens    FORCE ROW LEVEL SECURITY;
ALTER TABLE public.participant_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.srbai_logs           FORCE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_log         FORCE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL ON TABLES FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Atomic token claim. Doing this as SELECT-then-UPDATE in application code is a
-- time-of-check/time-of-use race: two simultaneous requests both see is_active
-- and both claim the same printed ledger. A single conditional UPDATE cannot.
-- Returns one row on success, zero rows if the token is unknown or spent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_activation_token(p_token_hmac CHAR(64))
RETURNS TABLE (id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.activation_tokens
       SET is_active = FALSE, claimed_at = NOW()
     WHERE token_hmac = p_token_hmac
       AND is_active = TRUE
    RETURNING activation_tokens.id;
$$;

REVOKE ALL ON FUNCTION public.claim_activation_token(CHAR) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Release a token if session creation fails after the claim. Without this, a
-- participant whose activation errors mid-flight loses their printed ledger.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_activation_token(p_token_hmac CHAR(64))
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.activation_tokens
       SET is_active = TRUE, claimed_at = NULL
     WHERE token_hmac = p_token_hmac
       AND NOT EXISTS (
           SELECT 1 FROM public.participant_sessions s
            WHERE s.token_hmac = p_token_hmac
       );
$$;

REVOKE ALL ON FUNCTION public.release_activation_token(CHAR) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Erasure (UK GDPR Art. 17). Triggered by an inbound "DELETE" SMS, which proves
-- control of the number without collecting any identity document.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.erase_participant(p_phone_hmac CHAR(64))
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE removed INTEGER;
BEGIN
    DELETE FROM public.participant_sessions WHERE phone_hmac = p_phone_hmac;
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.erase_participant(CHAR) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The Worker's role needs execute rights on the three functions above. Grant
-- them explicitly: the blanket REVOKE FROM PUBLIC removed the implicit grant.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.claim_activation_token(CHAR)   TO service_role;
GRANT EXECUTE ON FUNCTION public.release_activation_token(CHAR) TO service_role;
GRANT EXECUTE ON FUNCTION public.erase_participant(CHAR)        TO service_role;
