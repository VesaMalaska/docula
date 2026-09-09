"use client";

import { useSyncExternalStore, useCallback, useRef, useEffect } from "react";

/**
 * Custom hook that evaluates a CSS media query string and returns whether it matches.
 * Uses useSyncExternalStore for SSR hydration safety and consistent client updates.
 */
export function useMediaQuery(
  query: string,
  onChange?: (matches: boolean) => void
): boolean {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const subscribe = useCallback(
    (callback: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) {
        return () => {};
      }
      const mediaQueryList = window.matchMedia(query);
      const listener = (event: MediaQueryListEvent) => {
        onChangeRef.current?.(event.matches);
        callback();
      };
      mediaQueryList.addEventListener("change", listener);
      return () => {
        mediaQueryList.removeEventListener("change", listener);
      };
    },
    [query]
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return false;
    }
    return window.matchMedia(query).matches;
  }, [query]);

  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
