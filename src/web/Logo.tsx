/** The brand mark: three bars, ink, blue and yellow. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="logo"
    >
      <rect x="2" y="3" width="13" height="5" rx="2.5" fill="#0e0f11" />
      <rect x="2" y="10" width="20" height="5" rx="2.5" fill="#1f6bff" />
      <rect x="2" y="17" width="9" height="5" rx="2.5" fill="#ffd23f" />
    </svg>
  );
}
