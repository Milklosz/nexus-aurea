import { StrictMode, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import App from "./App";

function Startup() {
  useEffect(() => {
    if (!isTauri()) return;
    let readyFrame = 0;
    const renderFrame = requestAnimationFrame(() => {
      readyFrame = requestAnimationFrame(() => {
        void emitTo("main", "velora-startup-frontend-ready").catch((error: unknown) => {
          console.warn("VELORA startup signal could not be delivered", error);
        });
      });
    });
    return () => {
      cancelAnimationFrame(renderFrame);
      cancelAnimationFrame(readyFrame);
    };
  }, []);

  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Startup />
  </StrictMode>,
);
