/** Line icons from the Keep it moving mockups, sized by CSS (default 16px). */
const PATHS = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  inbox:
    "M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z",
  alert: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5M12 16h.01",
  play: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10 8l6 4-6 4z",
  pause: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10 9v6M14 9v6",
  check: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12l3 3 5-6",
  pr: "M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 8v8M6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 16V9a3 3 0 0 0-3-3h-4",
  ciGreen:
    "M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM8 12l3 3 5-6",
  ciRed:
    "M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM9 9l6 6M15 9l-6 6",
  ciPending:
    "M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM12 8v4l2 2",
  heartbeat: "M3 12h4l3-7 4 14 3-7h4",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  followUp: "M5 5v7a3 3 0 0 0 3 3h11M15 11l4 4-4 4",
  back: "M15 18l-6-6 6-6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  className,
  label,
}: {
  name: IconName;
  className?: string;
  /** Spoken name; without one the icon is decorative. */
  label?: string;
}) {
  return (
    <svg
      className={`kim-shell-icon ${className ?? ""}`}
      viewBox="0 0 24 24"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
