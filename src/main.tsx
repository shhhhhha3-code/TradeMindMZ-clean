import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { AppWrapper } from "./components/common/PageMeta.tsx";
import { supabaseConfigurationError } from "./db/supabase";
import "./index.css";

Sentry.init({
  dsn: import.meta.env['VITE_SENTRY_DSN'] as string | undefined,
  environment: import.meta.env.MODE,
});

const root = createRoot(document.getElementById("root")!);

if (supabaseConfigurationError) {
  console.error(supabaseConfigurationError);
  root.render(
    <main style={{ padding: "2rem", color: "white", background: "#0f1117", minHeight: "100vh" }}>
      <h1>Application configuration error</h1>
      <p>{supabaseConfigurationError}</p>
    </main>,
  );
} else {
  root.render(
    <Sentry.ErrorBoundary fallback={<p>En feil oppstod. Vennligst last siden på nytt.</p>}>
      <AppWrapper>
        <App />
      </AppWrapper>
    </Sentry.ErrorBoundary>,
  );
}
