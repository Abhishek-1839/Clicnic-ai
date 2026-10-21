-- =====================================================================
-- Clinic AI - initial schema
-- Multi-clinic: every business row carries clinic_id, and RLS scopes
-- staff access to their own clinic. Run this once in the Supabase
-- SQL editor (or via the Supabase CLI).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table public.clinics (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  timezone    text not null default 'Asia/Kolkata',
  faq_kb      jsonb not null default '{}'::jsonb,   -- clinic knowledge base used for FAQ answers
  created_at  timestamptz not null default now()
);

create table public.doctors (
  id            uuid primary key default gen_random_uuid(),
  clinic_id     uuid not null references public.clinics(id) on delete cascade,
  name          text not null,
  specialty     text not null,
  working_days  smallint[] not null default '{1,2,3,4,5,6}',  -- 0=Sun ... 6=Sat
  start_time    time not null default '09:00',
  end_time      time not null default '17:00',
  slot_minutes  smallint not null default 30 check (slot_minutes between 10 and 120),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- One profile per auth user. Patients (optional accounts) have no clinic.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  clinic_id   uuid references public.clinics(id) on delete cascade,
  role        text not null check (role in ('admin', 'staff', 'doctor', 'patient')),
  full_name   text not null default '',
  doctor_id   uuid references public.doctors(id) on delete set null,  -- set for role = 'doctor'
  created_at  timestamptz not null default now(),
  constraint profiles_clinic_required check (role = 'patient' or clinic_id is not null)
);

create table public.patients (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics(id) on delete cascade,
  name        text not null,
  user_id     uuid references auth.users(id) on delete set null,  -- only if the patient made an account
  created_at  timestamptz not null default now()
);

create table public.appointments (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics(id) on delete cascade,
  ref_code    text not null,
  patient_id  uuid not null references public.patients(id) on delete cascade,
  doctor_id   uuid not null references public.doctors(id) on delete restrict,
  slot_start  timestamptz not null,
  slot_end    timestamptz not null,
  reason      text not null default '',
  status      text not null default 'pending'
              check (status in ('pending', 'confirmed', 'cancelled', 'completed', 'no_show')),
  source      text not null default 'chat',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint appointments_slot_order check (slot_end > slot_start),
  constraint appointments_ref_unique unique (clinic_id, ref_code)
);

-- Double-booking guard: a doctor can hold only one active appointment per slot.
-- Cancelled / completed / no-show rows release the slot automatically.
create unique index appointments_doctor_slot_active
  on public.appointments (doctor_id, slot_start)
  where status in ('pending', 'confirmed');

create index appointments_clinic_status_idx on public.appointments (clinic_id, status);
create index appointments_doctor_slot_idx   on public.appointments (doctor_id, slot_start);
create index appointments_patient_idx       on public.appointments (patient_id);

create table public.appointment_status_history (
  id              bigint generated always as identity primary key,
  appointment_id  uuid not null references public.appointments(id) on delete cascade,
  clinic_id       uuid not null references public.clinics(id) on delete cascade,
  old_status      text,
  new_status      text not null,
  changed_by      uuid,                       -- auth user id; null when changed by the system / chat agent
  changed_at      timestamptz not null default now()
);

create table public.conversations (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics(id) on delete cascade,
  patient_id  uuid references public.patients(id) on delete set null,
  state       jsonb not null default '{}'::jsonb,   -- booking state machine lives here
  status      text not null default 'open'
              check (status in ('open', 'awaiting_staff', 'resolved')),
  urgent      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index conversations_clinic_status_idx on public.conversations (clinic_id, status);

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  clinic_id        uuid not null references public.clinics(id) on delete cascade,
  role             text not null check (role in ('patient', 'ai', 'staff')),
  content          text not null,
  ai_generated     boolean not null default false,
  review_status    text not null default 'sent' check (review_status in ('draft', 'approved', 'sent')),
  created_at       timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

create table public.ai_events (
  id               bigint generated always as identity primary key,
  clinic_id        uuid references public.clinics(id) on delete cascade,
  conversation_id  uuid references public.conversations(id) on delete set null,
  provider         text,            -- groq | gemini | fallback
  intent           text,
  extracted        jsonb,
  latency_ms       integer,
  error            text,
  created_at       timestamptz not null default now()
);

create index ai_events_clinic_idx on public.ai_events (clinic_id, created_at desc);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger appointments_touch before update on public.appointments
  for each row execute function public.touch_updated_at();

create trigger conversations_touch before update on public.conversations
  for each row execute function public.touch_updated_at();

-- Audit trail for staff status changes.
create or replace function public.log_appointment_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    insert into public.appointment_status_history (appointment_id, clinic_id, old_status, new_status, changed_by)
    values (new.id, new.clinic_id, old.status, new.status, auth.uid());
  end if;
  return new;
end;
$$;

create trigger appointments_status_log after update of status on public.appointments
  for each row execute function public.log_appointment_status();

-- ---------------------------------------------------------------------
-- RLS helper functions (SECURITY DEFINER avoids recursive policy checks)
-- ---------------------------------------------------------------------

create or replace function public.current_clinic_id()
returns uuid language sql stable security definer set search_path = public as $$
  select clinic_id from public.profiles where id = auth.uid()
$$;

create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.current_doctor_id()
returns uuid language sql stable security definer set search_path = public as $$
  select doctor_id from public.profiles where id = auth.uid()
$$;

-- True when the caller is admin/staff of the given clinic.
create or replace function public.is_clinic_staff(target_clinic uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('admin', 'staff')
      and clinic_id = target_clinic
  )
$$;

create or replace function public.is_clinic_admin(target_clinic uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and clinic_id = target_clinic
  )
$$;

create or replace function public.owns_patient(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.patients where id = pid and user_id = auth.uid())
$$;

create or replace function public.doctor_has_patient(pid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.appointments a
    where a.patient_id = pid and a.doctor_id = public.current_doctor_id()
  )
$$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- Patient chat and booking go through server API routes using the
-- service-role key (which bypasses RLS) with validation. These policies
-- govern direct access by logged-in staff / doctors / patients.
-- ---------------------------------------------------------------------

alter table public.clinics                    enable row level security;
alter table public.doctors                    enable row level security;
alter table public.profiles                   enable row level security;
alter table public.patients                   enable row level security;
alter table public.appointments               enable row level security;
alter table public.appointment_status_history enable row level security;
alter table public.conversations              enable row level security;
alter table public.messages                   enable row level security;
alter table public.ai_events                  enable row level security;

-- clinics
create policy clinics_select on public.clinics for select to authenticated
  using (id = public.current_clinic_id());
create policy clinics_update_admin on public.clinics for update to authenticated
  using (public.is_clinic_admin(id)) with check (public.is_clinic_admin(id));

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_clinic_staff(clinic_id));

-- doctors (any member of the clinic can read; admin manages)
create policy doctors_select on public.doctors for select to authenticated
  using (clinic_id = public.current_clinic_id());
create policy doctors_insert_admin on public.doctors for insert to authenticated
  with check (public.is_clinic_admin(clinic_id));
create policy doctors_update_admin on public.doctors for update to authenticated
  using (public.is_clinic_admin(clinic_id)) with check (public.is_clinic_admin(clinic_id));
create policy doctors_delete_admin on public.doctors for delete to authenticated
  using (public.is_clinic_admin(clinic_id));

-- patients
create policy patients_select on public.patients for select to authenticated
  using (
    public.is_clinic_staff(clinic_id)
    or user_id = auth.uid()
    or (public.current_role_name() = 'doctor' and public.doctor_has_patient(id))
  );
create policy patients_update_staff on public.patients for update to authenticated
  using (public.is_clinic_staff(clinic_id)) with check (public.is_clinic_staff(clinic_id));

-- appointments
create policy appointments_select on public.appointments for select to authenticated
  using (
    public.is_clinic_staff(clinic_id)
    or (public.current_role_name() = 'doctor' and doctor_id = public.current_doctor_id())
    or public.owns_patient(patient_id)
  );
create policy appointments_insert_staff on public.appointments for insert to authenticated
  with check (public.is_clinic_staff(clinic_id));
create policy appointments_update_staff on public.appointments for update to authenticated
  using (public.is_clinic_staff(clinic_id)) with check (public.is_clinic_staff(clinic_id));
-- Doctors may only close out their own appointments.
create policy appointments_update_doctor on public.appointments for update to authenticated
  using (public.current_role_name() = 'doctor' and doctor_id = public.current_doctor_id())
  with check (
    public.current_role_name() = 'doctor'
    and doctor_id = public.current_doctor_id()
    and status in ('completed', 'no_show')
  );

-- status history (read-only for staff; written by trigger)
create policy history_select on public.appointment_status_history for select to authenticated
  using (public.is_clinic_staff(clinic_id));

-- conversations / messages / ai_events (staff only)
create policy conversations_select on public.conversations for select to authenticated
  using (public.is_clinic_staff(clinic_id));
create policy conversations_update on public.conversations for update to authenticated
  using (public.is_clinic_staff(clinic_id)) with check (public.is_clinic_staff(clinic_id));

create policy messages_select on public.messages for select to authenticated
  using (public.is_clinic_staff(clinic_id));
create policy messages_insert on public.messages for insert to authenticated
  with check (public.is_clinic_staff(clinic_id));
create policy messages_update on public.messages for update to authenticated
  using (public.is_clinic_staff(clinic_id)) with check (public.is_clinic_staff(clinic_id));

create policy ai_events_select on public.ai_events for select to authenticated
  using (public.is_clinic_staff(clinic_id));
