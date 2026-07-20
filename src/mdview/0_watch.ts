import { useEffect, useRef } from "react";
import { claimFsWatch } from "../fsWatch";

export function useFsWatch(path: string, onChange: () => void, recursive = false): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let disposed = false;
    let release: (() => void) | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    claimFsWatch(path, () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => onChangeRef.current(), 75);
    }, recursive).then((stop) => {
      if (disposed) stop();
      else release = stop;
    }).catch(console.error);

    return () => {
      disposed = true;
      clearTimeout(refreshTimer);
      release?.();
    };
  }, [path, recursive]);
}
