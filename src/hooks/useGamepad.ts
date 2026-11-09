import { useEffect, useRef } from "react";

export function useGamepad(focusApp: (index: number) => void, onActivate: () => void, onMenu: () => void) {
  const activateRef = useRef(onActivate);
  const menuRef = useRef(onMenu);

  useEffect(() => {
    activateRef.current = onActivate;
  }, [onActivate]);

  useEffect(() => {
    menuRef.current = onMenu;
  }, [onMenu]);

  useEffect(() => {
    if (!navigator.getGamepads) return;

    let frame = 0;
    let previous = { left: false, right: false, open: false, menu: false };

    const poll = () => {
      const pads = Array.from(navigator.getGamepads() ?? []).filter((pad) => pad?.connected);
      const pad = pads[0];

      if (!pad) {
        previous = { left: false, right: false, open: false, menu: false };
      } else {
        const horizontal = pad.axes[0] ?? 0;
        const left = Boolean(pad.buttons[14]?.pressed || horizontal < -0.6);
        const right = Boolean(pad.buttons[15]?.pressed || horizontal > 0.6);
        const open = Boolean(pad.buttons[0]?.pressed);
        const menu = Boolean(pad.buttons[9]?.pressed);

        if (left && !previous.left) focusApp(-1);
        else if (right && !previous.right) focusApp(1);
        if (open && !previous.open) activateRef.current();
        if (menu && !previous.menu) menuRef.current();
        previous = { left, right, open, menu };
      }

      frame = window.requestAnimationFrame(poll);
    };

    frame = window.requestAnimationFrame(poll);
    return () => window.cancelAnimationFrame(frame);
  }, [focusApp]);
}
