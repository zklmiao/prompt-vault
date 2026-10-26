import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import QuickPick from "./QuickPick";
import { applyWindowModeClass, windowLabel } from "./window";

applyWindowModeClass();

function Root() {
  return windowLabel() === "quickpick" ? <QuickPick /> : <App />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
