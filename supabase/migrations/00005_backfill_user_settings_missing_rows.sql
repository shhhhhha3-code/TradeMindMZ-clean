
-- Backfill: create default user_settings rows for any profiles that don't have one yet.
-- Safe to run multiple times (INSERT ... ON CONFLICT DO NOTHING).
INSERT INTO public.user_settings (user_id)
SELECT p.id
FROM public.profiles p
LEFT JOIN public.user_settings s ON s.user_id = p.id
WHERE s.id IS NULL
ON CONFLICT (user_id) DO NOTHING;
