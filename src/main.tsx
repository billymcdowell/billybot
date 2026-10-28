import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "next-themes";
import App from "./App";
import "./index.css";

// next-themes follows the system's light/dark setting unless the user picks one in the header,
// and remembers the choice. shadcn's dark theme switches on the "dark" class.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange storageKey="billybot-theme">
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
