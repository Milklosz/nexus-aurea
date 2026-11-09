import { useCallback, useEffect, useRef, useState } from "react";

export function useToast() {
  const [message, setMessage] = useState("");
  const timer = useRef<number | undefined>(undefined);

  const showToast = useCallback((nextMessage: string) => {
    setMessage(nextMessage);
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setMessage("");
      timer.current = undefined;
    }, 2400);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
  );

  return { message, showToast };
}
