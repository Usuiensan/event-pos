import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function RegisterShell() {
  return <main className="register-shell"><p className="eyebrow">event-pos</p><h1>会計待ち</h1><p>商品を登録すると、ここに会計内容が表示されます。</p></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><RegisterShell /></StrictMode>);
