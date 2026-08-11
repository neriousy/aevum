import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Indicator } from "./Indicator";
import "./styles.css";

const isIndicator = window.location.hash === "#/indicator";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isIndicator ? <Indicator /> : <App />}</StrictMode>,
);
