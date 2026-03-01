import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { BottomNav } from "./BottomNav";

interface Props {
  children: ReactNode;
  lastProfileId: string | null;
}

export function AppShell({ children, lastProfileId }: Props) {
  return (
    <div className="app-shell">
      <Sidebar lastProfileId={lastProfileId} />
      <main className="app-main">{children}</main>
      <BottomNav lastProfileId={lastProfileId} />
    </div>
  );
}
