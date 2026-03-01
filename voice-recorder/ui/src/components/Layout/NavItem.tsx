import { Link, useRouter, matchRoute } from "../../router";

interface Props {
  to: string;
  icon: string;
  label: string;
  matchPattern?: string;
  disabled?: boolean;
  onDisabledClick?: () => void;
}

export function NavItem({
  to,
  icon,
  label,
  matchPattern,
  disabled,
  onDisabledClick,
}: Props) {
  const { path } = useRouter();
  const pattern = matchPattern ?? to;
  const active = pattern === "/"
    ? path === "/"
    : matchRoute(pattern, path) !== null || path.startsWith(to);

  if (disabled) {
    return (
      <button
        className={`nav-item disabled`}
        onClick={onDisabledClick}
        title={label}
      >
        <span className="nav-icon">{icon}</span>
        <span className="nav-label">{label}</span>
      </button>
    );
  }

  return (
    <Link to={to} className={`nav-item${active ? " active" : ""}`} title={label}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
    </Link>
  );
}
