import { useSyncExternalStore, type AnchorHTMLAttributes } from "react";

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

/** Moves to a path inside the shell without reloading the page. */
export function navigate(href: string): void {
  if (href === location.pathname) return;
  history.pushState(null, "", href);
  for (const listener of listeners) listener();
  window.scrollTo?.(0, 0);
}

/** The current path; re-renders on navigate() and the back button. */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

/** A link inside the shell. Modified clicks still open a new tab. */
export function Link({
  href,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(href);
      }}
    />
  );
}
