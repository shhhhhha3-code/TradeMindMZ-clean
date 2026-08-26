
                import { createClient, type SupabaseClient } from "@supabase/supabase-js";

                const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
                const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

                export const supabaseConfigurationError =
                    !supabaseUrl || !supabaseAnonKey
                        ? "Supabase configuration is missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
                        : null;

                // Keep the existing client API for all data consumers; main.tsx prevents use when config is absent.
                export const supabase: SupabaseClient = supabaseConfigurationError
                    ? (undefined as unknown as SupabaseClient)
                    : createClient(supabaseUrl, supabaseAnonKey);
                