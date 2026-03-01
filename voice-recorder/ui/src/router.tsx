import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
  type AnchorHTMLAttributes,
} from "react";

/* ── Route matching ── */

function parsePath(hash: string): string {
  const raw = hash.replace(/^#\/?/, "/");
  return raw === "" ? "/" : raw.replace(/\/+$/, "") || "/";
}

export function matchRoute(
  pattern: string,
  path: string
): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    const pv = pathParts[i]!;
    if (pp.startsWith(":")) {
      params[pp.slice(1)] = decodeURIComponent(pv);
    } else if (pp !== pv) {
      return null;
    }
  }
  return params;
}

/* ── Router context ── */

interface RouterContextValue {
  path: string;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouterContextValue>({
  path: "/",
  navigate: () => {},
});

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => parsePath(window.location.hash));

  useEffect(() => {
    const handler = () => setPath(parsePath(window.location.hash));
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const navigate = useCallback((to: string) => {
    window.location.hash = "#" + to;
  }, []);

  return (
    <RouterContext.Provider value={{ path, navigate }}>
      {children}
    </RouterContext.Provider>
  );
}

/* ── Hooks ── */

export function useRouter() {
  return useContext(RouterContext);
}

export function useMatch(pattern: string): Record<string, string> | null {
  const { path } = useRouter();
  return matchRoute(pattern, path);
}

/* ── Link component ── */

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  children: ReactNode;
}

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (onClick) onClick(e);
    // Let the browser handle hash change naturally
  };

  return (
    <a href={`#${to}`} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
